import Foundation
import OSLog
import CCModels

/// Unified-log logger for HubConnection. Stream from the terminal with:
///     log stream --predicate 'subsystem == "com.cc-commander.app"' --level debug
private let log = Logger(subsystem: "com.cc-commander.app", category: "HubConnection")

/// Connection state machine for the hub.
public enum HubConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
}

/// Manages the authenticated WebSocket connection to the hub.
/// Handles auth (via REST), WebSocket lifecycle, and reconnection.
///
/// All mutable state is isolated to @MainActor to prevent data races.
@MainActor
@Observable
public final class HubConnection {
    public private(set) var state: HubConnectionState = .disconnected

    /// Whether the user has credentials stored (survives reconnect flicker).
    public var hasStoredCredentials: Bool {
        keychain.jwt != nil
    }

    private let baseURL: URL
    private let authClient: any AuthClientProtocol
    private let keychain: any KeychainStoreProtocol
    private let wsClientFactory: @Sendable () -> any WebSocketClientProtocol

    private var wsClient: (any WebSocketClientProtocol)?
    private var messageStreamTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 30.0

    private var messageContinuation: AsyncThrowingStream<ServerMessage, Error>.Continuation?

    public init(
        baseURL: URL,
        authClient: any AuthClientProtocol,
        keychain: any KeychainStoreProtocol,
        wsClientFactory: @escaping @Sendable () -> any WebSocketClientProtocol
    ) {
        self.baseURL = baseURL
        self.authClient = authClient
        self.keychain = keychain
        self.wsClientFactory = wsClientFactory
    }

    /// Convenience init for production.
    public convenience init(baseURL: URL) {
        let keychain = KeychainStore()
        self.init(
            baseURL: baseURL,
            authClient: AuthClient(baseURL: baseURL),
            keychain: keychain,
            wsClientFactory: { WebSocketClient() }
        )
    }

    // MARK: - Auth

    public func login(email: String, password: String) async throws {
        log.info("login start email=\(email, privacy: .public)")
        do {
            let tokens = try await authClient.login(email: email, password: password)
            log.info("login REST ok, saving tokens")
            try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
            try await connectWebSocket(token: tokens.token)
            log.info("login complete, ws connected")
        } catch {
            log.error("login failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    public func register(email: String, password: String) async throws {
        let tokens = try await authClient.register(email: email, password: password)
        try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
        try await connectWebSocket(token: tokens.token)
    }

    /// Try to connect using stored tokens (app launch).
    /// Only attempts refresh if the WebSocket connection is rejected (auth error),
    /// not on transient network failures.
    public func connectWithStoredTokens() async throws {
        log.info("connectWithStoredTokens called")
        guard let token = keychain.jwt else {
            log.info("connectWithStoredTokens: no jwt in keychain")
            throw HubConnectionError.noStoredTokens
        }
        log.info("connectWithStoredTokens: jwt found len=\(token.count, privacy: .public), connecting ws")
        do {
            try await connectWebSocket(token: token)
            log.info("connectWithStoredTokens: ws connected with stored jwt")
        } catch WebSocketError.authRejected {
            log.info("connectWithStoredTokens: jwt rejected, trying refresh")
            guard let refresh = keychain.refreshToken else {
                log.error("connectWithStoredTokens: no refresh token available")
                throw WebSocketError.authRejected
            }
            let tokens = try await authClient.refresh(refreshToken: refresh)
            try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
            try await connectWebSocket(token: tokens.token)
            log.info("connectWithStoredTokens: ws connected with refreshed jwt")
        } catch {
            log.error("connectWithStoredTokens: ws connect failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    public func logout() async {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        messageStreamTask?.cancel()
        messageStreamTask = nil
        await wsClient?.disconnect()
        wsClient = nil
        messageContinuation?.finish()
        messageContinuation = nil
        try? keychain.clearTokens()
        state = .disconnected
    }

    // MARK: - Commands

    public func startSession(machineId: String, directory: String, prompt: String) async throws {
        try await send(.startSession(machineId: machineId, directory: directory, prompt: prompt))
    }

    public func sendPrompt(sessionId: String, prompt: String) async throws {
        try await send(.sendPrompt(sessionId: sessionId, prompt: prompt))
    }

    public func respondToPrompt(sessionId: String, promptId: String, response: UserPromptResponse) async throws {
        try await send(.respondToPrompt(sessionId: sessionId, promptId: promptId, response: response))
    }

    public func requestSessionList() async throws {
        try await send(.listSessions)
    }

    public func requestMachineList() async throws {
        try await send(.listMachines)
    }

    public func requestSessionHistory(sessionId: String) async throws {
        try await send(.getSessionHistory(sessionId: sessionId))
    }

    // MARK: - Message stream

    /// The single stream of incoming messages from the hub.
    /// AppState subscribes to this. Only one subscriber at a time --
    /// calling again terminates the previous stream.
    public func incomingMessages() -> AsyncThrowingStream<ServerMessage, Error> {
        log.info("incomingMessages: subscriber attaching")
        messageContinuation?.finish()
        return AsyncThrowingStream { continuation in
            self.messageContinuation = continuation
            // Re-request the bootstrap data: the hub auto-pushes
            // session_list and machine_list immediately on WebSocket
            // connect, but if connectWebSocket() ran before the
            // subscriber attached, those messages were yielded into a
            // nil continuation and dropped on the floor. Without this
            // re-request, every fresh login leaves the app showing an
            // empty machine list until the next message happens to
            // come in.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.state == .connected {
                    log.info("incomingMessages: connected; re-requesting machine_list + session_list")
                    try? await self.requestMachineList()
                    try? await self.requestSessionList()
                } else {
                    log.info("incomingMessages: not yet connected; bootstrap re-request skipped")
                }
            }
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in
                    self?.messageContinuation = nil
                }
            }
        }
    }

    // MARK: - Private

    private func send(_ message: ClientMessage) async throws {
        guard let ws = wsClient else {
            throw HubConnectionError.notConnected
        }
        try await ws.send(message)
    }

    private func connectWebSocket(token: String) async throws {
        log.info("connectWebSocket: building url from baseURL=\(self.baseURL.absoluteString, privacy: .public)")
        state = .connecting
        shouldReconnect = true
        reconnectDelay = 1.0

        // Build WSS URL with token in Authorization header (not query string,
        // to keep JWTs out of access logs).
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            log.error("connectWebSocket: URLComponents failed for baseURL")
            state = .disconnected
            throw HubConnectionError.invalidURL
        }
        components.path = "/ws/client"
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        guard let wsURL = components.url else {
            log.error("connectWebSocket: components.url returned nil")
            state = .disconnected
            throw HubConnectionError.invalidURL
        }
        log.info("connectWebSocket: connecting to \(wsURL.absoluteString, privacy: .public)")

        var request = URLRequest(url: wsURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let ws = wsClientFactory()
        do {
            try await ws.connect(request: request)
            log.info("connectWebSocket: ws.connect returned ok")
        } catch {
            log.error("connectWebSocket: ws.connect threw \(String(describing: error), privacy: .public)")
            // Connect failed -- don't store the leaked client, restore state
            state = .disconnected
            throw error
        }

        // Only commit the new client after successful connect
        self.wsClient = ws
        state = .connected
        reconnectDelay = 1.0
        log.info("connectWebSocket: state=connected, starting message reader")

        // Start reading messages
        messageStreamTask?.cancel()
        messageStreamTask = Task { @MainActor [weak self] in
            let stream = await ws.messages()
            do {
                for try await msg in stream {
                    log.debug("ws message received: \(String(describing: msg), privacy: .public)")
                    self?.messageContinuation?.yield(msg)
                }
                log.info("ws message stream ended cleanly")
                self?.handleDisconnect()
            } catch {
                log.error("ws message stream threw: \(String(describing: error), privacy: .public)")
                self?.handleDisconnect()
            }
        }
    }

    private func handleDisconnect() {
        state = .disconnected
        wsClient = nil
        guard shouldReconnect else { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { @MainActor [weak self] in
            // One task drains all reconnect attempts via a loop, so cancellation
            // doesn't race with self-rescheduling.
            while let self, self.shouldReconnect, !Task.isCancelled {
                let delay = self.reconnectDelay
                try? await Task.sleep(for: .seconds(delay))
                if Task.isCancelled { return }
                self.bumpReconnectDelay()

                do {
                    try await self.attemptReconnect()
                    return  // Connected -- exit the loop
                } catch {
                    // Loop and retry after the next backoff
                }
            }
        }
    }

    private func bumpReconnectDelay() {
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
    }

    private func attemptReconnect() async throws {
        // Try stored JWT first; only refresh if it's specifically rejected.
        // Other errors (network, server unreachable) bubble up so the loop
        // retries the same JWT after backoff -- not burning the refresh token.
        if let token = keychain.jwt {
            do {
                try await connectWebSocket(token: token)
                return
            } catch WebSocketError.authRejected {
                // JWT expired -- fall through to refresh
            }
        }
        guard let refresh = keychain.refreshToken else {
            throw HubConnectionError.noStoredTokens
        }
        let tokens = try await authClient.refresh(refreshToken: refresh)
        try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
        try await connectWebSocket(token: tokens.token)
    }
}

public enum HubConnectionError: Error, Sendable {
    case notConnected
    case noStoredTokens
    case invalidURL
}
