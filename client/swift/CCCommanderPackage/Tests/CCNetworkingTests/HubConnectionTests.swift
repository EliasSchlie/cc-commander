import Testing
import Foundation
@testable import CCNetworking
@testable import CCModels

@Suite("HubConnection")
@MainActor
struct HubConnectionTests {

    private func makeConnection(
        mockAuth: MockAuthClient = MockAuthClient(),
        mockWS: MockWebSocketClient = MockWebSocketClient(),
        keychain: MockKeychainStore = MockKeychainStore()
    ) -> (HubConnection, MockAuthClient, MockWebSocketClient, MockKeychainStore) {
        let conn = HubConnection(
            baseURL: URL(string: "https://hub.example.com")!,
            authClient: mockAuth,
            keychain: keychain,
            wsClientFactory: { mockWS }
        )
        return (conn, mockAuth, mockWS, keychain)
    }

    // Prevents: login doesn't store tokens, next launch requires re-login
    @Test func loginStoresTokensInKeychain() async throws {
        let (conn, _, _, keychain) = makeConnection()
        try await conn.login(email: "user@test.com", password: "pass")
        #expect(try keychain.load(key: "cc-commander-jwt") == "mock-jwt")
        #expect(try keychain.load(key: "cc-commander-refresh") == "mock-refresh")
    }

    // Prevents: login doesn't connect WebSocket, app stays on auth screen
    @Test func loginConnectsWebSocket() async throws {
        let mockWS = MockWebSocketClient()
        let (conn, _, _, _) = makeConnection(mockWS: mockWS)
        try await conn.login(email: "user@test.com", password: "pass")
        #expect(conn.state == .connected)
        let request = await mockWS.connectedRequest
        #expect(request?.url?.path == "/ws/client")
        // Token must be in Authorization header, not query string
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer mock-jwt")
        #expect(request?.url?.query == nil)
    }

    // Prevents: register doesn't work the same as login
    @Test func registerStoresTokensAndConnects() async throws {
        let mockWS = MockWebSocketClient()
        let (conn, _, _, keychain) = makeConnection(mockWS: mockWS)
        try await conn.register(email: "new@test.com", password: "pass")
        #expect(conn.state == .connected)
        #expect(try keychain.load(key: "cc-commander-jwt") == "mock-jwt")
    }

    // Prevents: WebSocket URL uses wrong scheme (http instead of wss)
    @Test func connectUsesWSSScheme() async throws {
        let mockWS = MockWebSocketClient()
        let (conn, _, _, _) = makeConnection(mockWS: mockWS)
        try await conn.login(email: "user@test.com", password: "pass")
        let url = await mockWS.connectedURL
        #expect(url?.scheme == "wss")
    }

    // Prevents: HTTP base URL produces wrong WebSocket scheme
    @Test func connectUsesWSForHTTP() async throws {
        let mockWS = MockWebSocketClient()
        let keychain = MockKeychainStore()
        let conn = HubConnection(
            baseURL: URL(string: "http://localhost:3000")!,
            authClient: MockAuthClient(),
            keychain: keychain,
            wsClientFactory: { mockWS }
        )
        try await conn.login(email: "user@test.com", password: "pass")
        let url = await mockWS.connectedURL
        #expect(url?.scheme == "ws")
    }

    // Prevents: logout doesn't clear tokens, auto-connects on next launch
    @Test func logoutClearsTokensAndDisconnects() async throws {
        let mockWS = MockWebSocketClient()
        let (conn, _, _, keychain) = makeConnection(mockWS: mockWS)
        try await conn.login(email: "user@test.com", password: "pass")
        await conn.logout()
        #expect(conn.state == .disconnected)
        #expect(try keychain.load(key: "cc-commander-jwt") == nil)
        #expect(try keychain.load(key: "cc-commander-refresh") == nil)
    }

    // Prevents: app can't resume session on relaunch
    @Test func connectWithStoredTokens() async throws {
        let mockWS = MockWebSocketClient()
        let keychain = MockKeychainStore()
        try keychain.save(key: "cc-commander-jwt", value: "stored-jwt")
        try keychain.save(key: "cc-commander-refresh", value: "stored-refresh")
        let (conn, _, _, _) = makeConnection(mockWS: mockWS, keychain: keychain)
        try await conn.connectWithStoredTokens()
        #expect(conn.state == .connected)
        let request = await mockWS.connectedRequest
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer stored-jwt")
    }

    // Prevents: no stored tokens throws unhandled error
    @Test func connectWithNoStoredTokensThrows() async {
        let (conn, _, _, _) = makeConnection()
        do {
            try await conn.connectWithStoredTokens()
            Issue.record("Should have thrown")
        } catch {
            #expect(error is HubConnectionError)
        }
    }

    // Prevents: failed connect leaks .connecting state and orphans the wsClient,
    // making isAuthenticated falsely true on next launch attempt
    @Test func failedConnectRestoresDisconnectedState() async {
        let mockWS = MockWebSocketClient(shouldFailConnect: true)
        let (conn, _, _, _) = makeConnection(mockWS: mockWS)
        do {
            try await conn.login(email: "user@test.com", password: "pass")
            Issue.record("Login should have thrown")
        } catch {
            // Expected
        }
        #expect(conn.state == .disconnected)
    }

    // Prevents: send before connect crashes
    @Test func sendBeforeConnectThrows() async {
        let (conn, _, _, _) = makeConnection()
        do {
            try await conn.startSession(machineId: "m1", directory: "/tmp", prompt: "hi")
            Issue.record("Should have thrown")
        } catch {
            #expect(error is HubConnectionError)
        }
    }

    // Prevents: commands not forwarded to WebSocket
    @Test func sendCommandsAfterConnect() async throws {
        let mockWS = MockWebSocketClient()
        let (conn, _, _, _) = makeConnection(mockWS: mockWS)
        try await conn.login(email: "user@test.com", password: "pass")
        try await conn.startSession(machineId: "m1", directory: "/project", prompt: "Fix bug")
        let sent = await mockWS.sentMessages
        #expect(sent.count == 1)
    }

    // Prevents: messages from hub not relayed to subscribers
    @Test func incomingMessagesRelayed() async throws {
        let sessionMeta = SessionMeta(
            sessionId: "s1", accountId: "a1", machineId: "m1",
            directory: "/tmp", status: .idle,
            lastActivity: Date(), lastMessagePreview: "hello",
            createdAt: Date()
        )
        let mockWS = MockWebSocketClient(scriptedMessages: [
            .sessionList([sessionMeta])
        ])
        let (conn, _, _, _) = makeConnection(mockWS: mockWS)

        let stream = conn.incomingMessages()
        try await conn.login(email: "user@test.com", password: "pass")

        // Give the message stream task time to start and relay
        try await Task.sleep(for: .milliseconds(50))

        var received: [ServerMessage] = []
        // Finish the stream so we can collect
        await mockWS.finishStream()
        for try await msg in stream {
            received.append(msg)
            if received.count >= 1 { break }
        }
        #expect(received.count == 1)
        guard case .sessionList(let sessions) = received[0] else {
            Issue.record("Expected sessionList")
            return
        }
        #expect(sessions[0].sessionId == "s1")
    }
}
