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
@Observable
public final class HubConnection: @unchecked Sendable {
    public private(set) var state: HubConnectionState = .disconnected

    private let baseURL: URL
    private let authClient: any AuthClientProtocol
    private let keychain: any KeychainStoreProtocol
    private let wsClientFactory: () -> any WebSocketClientProtocol

    private var wsClient: (any WebSocketClientProtocol)?
    private var messageStreamTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 30.0

    // Continuation for the public message stream
    private var messageContinuation: AsyncThrowingStream<ServerMessage, Error>.Continuation?

    public init(
        baseURL: URL,
        authClient: any AuthClientProtocol,
        keychain: any KeychainStoreProtocol,
        wsClientFactory: @escaping () -> any WebSocketClientProtocol
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
    public func connectWithStoredTokens() async throws {
        guard let token = keychain.jwt else {
            throw HubConnectionError.noStoredTokens
        }
        do {
            try await connectWebSocket(token: token)
        } catch {
            // Token might be expired, try refresh
            guard let refresh = keychain.refreshToken else { throw error }
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
    /// AppState subscribes to this.
    public func incomingMessages() -> AsyncThrowingStream<ServerMessage, Error> {
        AsyncThrowingStream { continuation in
            self.messageContinuation = continuation
            continuation.onTermination = { [weak self] _ in
                self?.messageContinuation = nil
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

        let ws = wsClientFactory()
        self.wsClient = ws

        // Build WSS URL
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/ws/device"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        if components.scheme == "https" {
            components.scheme = "wss"
        } else {
            components.scheme = "ws"
        }
        let wsURL = components.url!

        try await ws.connect(url: wsURL)
        state = .connected
        reconnectDelay = 1.0

        // Start reading messages
        messageStreamTask?.cancel()
        messageStreamTask = Task { [weak self] in
            let stream = await ws.messages()
            do {
                for try await msg in stream {
                    self?.messageContinuation?.yield(msg)
                }
                // Stream ended normally
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
        reconnectTask = Task { [weak self] in
            guard let self, shouldReconnect else { return }
            let delay = reconnectDelay
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, shouldReconnect else { return }

            // Increase delay for next attempt
            reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)

            // Try refresh + reconnect
            do {
                if let refresh = keychain.refreshToken {
                    let tokens = try await authClient.refresh(refreshToken: refresh)
                    try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
                    try await connectWebSocket(token: tokens.token)
                } else if let token = keychain.jwt {
                    try await connectWebSocket(token: token)
                }
            } catch {
                // Retry
                if shouldReconnect {
                    scheduleReconnect()
                }
            }
        }
    }
}

public enum HubConnectionError: Error, Sendable {
    case notConnected
    case noStoredTokens
}
