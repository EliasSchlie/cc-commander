import Foundation
import CCLog
import CCModels

private let log = CCLog.Logger("WebSocketClient")

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
        log.info("connect: creating ws task", ["url": .string(request.url?.absoluteString ?? "?")])
        let task = session.webSocketTask(with: request)
        task.resume()

        // Drive the handshake to completion by awaiting the first frame.
        // URLSessionWebSocketTask's `sendPing` callback is unreliable
        // (it's silently dropped when the upstream proxy doesn't forward
        // pongs) and `task.state` is `.running` immediately after
        // `resume()`, so neither gives us a real "upgraded" signal. The
        // hub pushes `session_list` + `machine_list` as the very first
        // frames after a successful upgrade, so we use the first frame
        // as the handshake-complete indicator -- and stash it so the
        // caller's `messages()` stream replays it instead of dropping
        // the bootstrap on the floor.
        //
        // An external timer cancels the task if the handshake hangs,
        // because `task.cancel()` is the only reliable way to make
        // `receive()` return with an error.
        let deadline = DispatchTime.now() + .seconds(Int(Self.connectTimeoutSecs))
        let timer = DispatchWorkItem { [weak self] in
            Task { [weak self] in
                await self?.cancelPending(task: task, reason: "connect timeout")
            }
        }
        DispatchQueue.global().asyncAfter(deadline: deadline, execute: timer)

        do {
            log.info("connect: awaiting first frame as handshake signal")
            let first = try await task.receive()
            timer.cancel()
            log.info("connect: first frame received, upgrade complete")
            self.task = task
            self.pendingFirstMessage = first
        } catch {
            timer.cancel()
            let closeCode = task.closeCode
            task.cancel()
            log.error("connect: failed", [
                "state": .int(task.state.rawValue),
                "closeCode": .int(closeCode.rawValue),
                "error": .string(String(describing: error)),
            ])
            if closeCode.rawValue == 4001 {
                throw WebSocketError.authRejected
            }
            throw WebSocketError.connectionFailed(error.localizedDescription)
        }
    }

    private var pendingFirstMessage: URLSessionWebSocketTask.Message?

    private func cancelPending(task: URLSessionWebSocketTask, reason: String) {
        // Only cancel if we haven't already committed this task as the
        // active one (i.e. `connect()` hasn't returned success yet).
        // Cancelling a task that already completed normally is harmless,
        // but this guard avoids the log noise and tearing down a healthy
        // connection if the timer fires a nanosecond after success.
        guard self.task !== task else { return }
        log.error("connect: cancelling ws task", ["reason": .string(reason)])
        task.cancel()
    }

    private static let connectTimeoutSecs: TimeInterval = 10

    public func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    public func send(_ message: ClientMessage) async throws {
        guard let task else {
            throw WebSocketError.notConnected
        }
        let data = try encoder.encode(message)
        log.debug("ws send", ["bytes": .int(data.count)])
        try await task.send(.data(data))
    }

    public func messages() -> AsyncThrowingStream<ServerMessage, Error> {
        let task = self.task
        let decoder = self.decoder
        // Take the message that connect() consumed to detect upgrade and
        // hand it to the stream so the bootstrap session_list/machine_list
        // isn't lost.
        let primer = self.pendingFirstMessage
        self.pendingFirstMessage = nil
        return AsyncThrowingStream { continuation in
            let readTask = Task {
                guard let ws = task else {
                    continuation.finish(throwing: WebSocketError.notConnected)
                    return
                }
                func emit(_ wsMessage: URLSessionWebSocketTask.Message) throws {
                    let data: Data
                    switch wsMessage {
                    case .data(let d):
                        data = d
                    case .string(let s):
                        guard let d = s.data(using: .utf8) else { return }
                        data = d
                    @unknown default:
                        return
                    }
                    let serverMsg = try decoder.decode(ServerMessage.self, from: data)
                    continuation.yield(serverMsg)
                }
                do {
                    if let primer { try emit(primer) }
                    while !Task.isCancelled {
                        let wsMessage = try await ws.receive()
                        try emit(wsMessage)
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
