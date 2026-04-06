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

    public func connect(url: URL) async throws {
        let task = session.webSocketTask(with: url)
        task.resume()
        self.task = task
        // Send a ping to verify connection is alive
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

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
}
