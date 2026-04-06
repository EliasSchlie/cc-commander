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
        } catch let error as WebSocketError {
            // Only refresh on auth rejection, not network errors
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

        let ws = wsClientFactory()
        self.wsClient = ws

        // Build WSS URL
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw HubConnectionError.invalidURL
        }
        components.path = "/ws/client"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        if components.scheme == "https" {
            components.scheme = "wss"
        } else {
            components.scheme = "ws"
        }
        guard let wsURL = components.url else {
            throw HubConnectionError.invalidURL
        }

        try await ws.connect(url: wsURL)
        state = .connected
        reconnectDelay = 1.0

        // Start reading messages
        messageStreamTask?.cancel()
        messageStreamTask = Task { [weak self] in
            let stream = await ws.messages()
            do {
                for try await msg in stream {
                    await self?.messageContinuation?.yield(msg)
                }
                await self?.handleDisconnect()
            } catch {
                await self?.handleDisconnect()
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

            reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)

            do {
                // Try stored JWT first; only refresh if that fails
                if let token = keychain.jwt {
                    try await connectWebSocket(token: token)
                } else if let refresh = keychain.refreshToken {
                    let tokens = try await authClient.refresh(refreshToken: refresh)
                    try keychain.saveTokens(jwt: tokens.token, refreshToken: tokens.refreshToken)
                    try await connectWebSocket(token: tokens.token)
                }
            } catch {
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
    case invalidURL
}
