import Foundation
import CCModels

/// Mock WebSocket client for tests and SwiftUI previews.
/// Feed it scripted messages and inspect what was sent.
public actor MockWebSocketClient: WebSocketClientProtocol {
    public private(set) var isConnected = false
    public private(set) var sentMessages: [ClientMessage] = []
    public private(set) var connectedURL: URL?

    private var scriptedMessages: [ServerMessage]
    private var continuation: AsyncThrowingStream<ServerMessage, Error>.Continuation?
    private var shouldFailConnect: Bool

    public init(scriptedMessages: [ServerMessage] = [], shouldFailConnect: Bool = false) {
        self.scriptedMessages = scriptedMessages
        self.shouldFailConnect = shouldFailConnect
    }

    public func connect(url: URL) async throws {
        if shouldFailConnect {
            throw WebSocketError.connectionFailed("Mock connection failure")
        }
        connectedURL = url
        isConnected = true
    }

    public func disconnect() {
        isConnected = false
        continuation?.finish()
        continuation = nil
    }

    public func send(_ message: ClientMessage) async throws {
        guard isConnected else { throw WebSocketError.notConnected }
        sentMessages.append(message)
    }

    public func messages() -> AsyncThrowingStream<ServerMessage, Error> {
        let scripted = scriptedMessages
        return AsyncThrowingStream { continuation in
            self.setContinuation(continuation)
            Task {
                for msg in scripted {
                    continuation.yield(msg)
                }
            }
        }
    }

    // Allow tests to inject additional messages after stream is created
    public func injectMessage(_ message: ServerMessage) {
        continuation?.yield(message)
    }

    public func finishStream(throwing error: Error? = nil) {
        if let error {
            continuation?.finish(throwing: error)
        } else {
            continuation?.finish()
        }
        continuation = nil
    }

    private func setContinuation(_ c: AsyncThrowingStream<ServerMessage, Error>.Continuation) {
        self.continuation = c
    }
}
