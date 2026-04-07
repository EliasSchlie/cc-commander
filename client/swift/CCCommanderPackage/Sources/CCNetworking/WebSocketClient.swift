import Foundation
import CCModels

/// Production WebSocket client wrapping URLSessionWebSocketTask.
public actor WebSocketClient: WebSocketClientProtocol {
    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(session: URLSession = .shared) {
        self.session = session
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
        self.encoder = JSONEncoder()
    }

    public func connect(request: URLRequest) async throws {
        let task = session.webSocketTask(with: request)
        task.resume()
        // Verify the connection by sending a ping. URLSessionWebSocketTask's
        // sendPing completion handler is NOT guaranteed to fire — if the
        // underlying TCP/TLS connection terminates before the pong roundtrip
        // completes, the closure is silently dropped and the calling Task
        // hangs forever ("SWIFT TASK CONTINUATION MISUSE: connect(request:)
        // leaked its continuation"). Race the ping against a timeout so a
        // stuck callback can't suspend the connect() caller indefinitely.
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    try await withCheckedThrowingContinuation {
                        (continuation: CheckedContinuation<Void, Error>) in
                        task.sendPing { error in
                            if let error {
                                continuation.resume(throwing: error)
                            } else {
                                continuation.resume()
                            }
                        }
                    }
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: Self.connectTimeoutNs)
                    throw WebSocketError.connectionFailed(
                        "connect timed out after \(Self.connectTimeoutNs / 1_000_000_000)s"
                    )
                }
                // First task to finish wins; cancel the other.
                try await group.next()
                group.cancelAll()
            }
        } catch {
            // The server may have rejected us. Check the close code to
            // distinguish auth rejection (4001) from network failure.
            // Note: closeCode is .invalid until the close handshake completes.
            let closeCode = task.closeCode
            task.cancel()
            if closeCode.rawValue == 4001 {
                throw WebSocketError.authRejected
            }
            throw WebSocketError.connectionFailed(error.localizedDescription)
        }
        self.task = task
    }

    private static let connectTimeoutNs: UInt64 = 10_000_000_000  // 10s

    public func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    public func send(_ message: ClientMessage) async throws {
        guard let task else {
            throw WebSocketError.notConnected
        }
        let data = try encoder.encode(message)
        try await task.send(.data(data))
    }

    public func messages() -> AsyncThrowingStream<ServerMessage, Error> {
        let task = self.task
        let decoder = self.decoder
        return AsyncThrowingStream { continuation in
            let readTask = Task {
                guard let ws = task else {
                    continuation.finish(throwing: WebSocketError.notConnected)
                    return
                }
                do {
                    while !Task.isCancelled {
                        let wsMessage = try await ws.receive()
                        let data: Data
                        switch wsMessage {
                        case .data(let d):
                            data = d
                        case .string(let s):
                            guard let d = s.data(using: .utf8) else { continue }
                            data = d
                        @unknown default:
                            continue
                        }
                        let serverMsg = try decoder.decode(ServerMessage.self, from: data)
                        continuation.yield(serverMsg)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                readTask.cancel()
            }
        }
    }
}

public enum WebSocketError: Error, Sendable {
    case notConnected
    case connectionFailed(String)
    /// Server rejected the connection due to invalid/expired credentials
    /// (WebSocket close code 4001). Triggers a token refresh.
    case authRejected
}
