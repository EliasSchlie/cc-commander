import Foundation
import CCModels

/// Protocol for WebSocket communication with the hub.
/// Abstracted for testability -- production uses URLSessionWebSocketTask,
/// tests use MockWebSocketClient.
public protocol WebSocketClientProtocol: Sendable {
    func connect(request: URLRequest) async throws
    func disconnect() async
    func send(_ message: ClientMessage) async throws
    func messages() async -> AsyncThrowingStream<ServerMessage, Error>
}
