import Foundation
import CCModels

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
        let tokens = try await authClient.login(email: email, password: password)
        try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
        try await connectWebSocket(token: tokens.token)
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
        guard let token = keychain.jwt else {
            throw HubConnectionError.noStoredTokens
        }
        do {
            try await connectWebSocket(token: token)
        } catch WebSocketError.authRejected {
            // JWT was rejected -- try to refresh it
            guard let refresh = keychain.refreshToken else {
                throw WebSocketError.authRejected
            }
            let tokens = try await authClient.refresh(refreshToken: refresh)
            try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
            try await connectWebSocket(token: tokens.token)
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
        messageContinuation?.finish()
        return AsyncThrowingStream { continuation in
            self.messageContinuation = continuation
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
        state = .connecting
        shouldReconnect = true
        reconnectDelay = 1.0

        // Build WSS URL with token in Authorization header (not query string,
        // to keep JWTs out of access logs).
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            state = .disconnected
            throw HubConnectionError.invalidURL
        }
        components.path = "/ws/client"
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        guard let wsURL = components.url else {
            state = .disconnected
            throw HubConnectionError.invalidURL
        }

        var request = URLRequest(url: wsURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let ws = wsClientFactory()
        do {
            try await ws.connect(request: request)
        } catch {
            // Connect failed -- don't store the leaked client, restore state
            state = .disconnected
            throw error
        }

        // Only commit the new client after successful connect
        self.wsClient = ws
        state = .connected
        reconnectDelay = 1.0

        // Start reading messages
        messageStreamTask?.cancel()
        messageStreamTask = Task { @MainActor [weak self] in
            let stream = await ws.messages()
            do {
                for try await msg in stream {
                    self?.messageContinuation?.yield(msg)
                }
                self?.handleDisconnect()
            } catch {
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
