import Foundation
import Observation
import OSLog
import CCModels
import CCNetworking

private let log = Logger(subsystem: "com.cc-commander.app", category: "AppState")

/// A transient error surfaced from the hub (or a local action) so the UI
/// can show it to the user instead of swallowing it. Identifiable so the
/// SwiftUI alert presentation can re-fire when a new error replaces an
/// existing one with the same text.
public struct HubErrorToast: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let message: String
    public init(message: String) {
        self.id = UUID()
        self.message = message
    }
}

/// Canonical app state. Owns the hub connection and holds all sessions/machines.
@MainActor
@Observable
public final class AppState {
    public let connection: HubConnection

    public var sessions: [SessionMeta] = []
    public var machines: [MachineInfo] = []
    public var selectedSessionId: String? {
        didSet {
            // Eagerly create a stream and request history when a session is
            // selected. Without this, the view stays stuck on a "Loading
            // session..." spinner because the stream dictionary is only
            // populated by inbound messages -- selecting an idle session
            // (which has no live messages) would never trigger anything.
            guard let id = selectedSessionId, oldValue != id else { return }
            ensureStreamAndLoadHistory(sessionId: id)
        }
    }
    public var sessionStreams: [String: SessionStream] = [:]

    /// Most recent hub error, surfaced to the UI as a toast/alert. Set to
    /// `nil` after the user dismisses it. Previously these were `print()`d
    /// and silently dropped, which made every hub-side validation failure
    /// (offline machine, invalid directory, ...) look like "nothing
    /// happened" to the user.
    public var lastError: HubErrorToast?

    public var isAuthenticated: Bool {
        connection.state == .connected || connection.hasStoredCredentials
    }

    public var sortedSessions: [SessionMeta] {
        sessions.sorted { $0.lastActivity > $1.lastActivity }
    }

    public var onlineMachines: [MachineInfo] {
        machines.filter(\.online).sorted { $0.name < $1.name }
    }

    public var offlineMachines: [MachineInfo] {
        machines.filter { !$0.online }.sorted { $0.name < $1.name }
    }

    public var selectedSession: SessionMeta? {
        guard let id = selectedSessionId else { return nil }
        return sessions.first { $0.sessionId == id }
    }

    public var selectedSessionStream: SessionStream? {
        guard let id = selectedSessionId else { return nil }
        return sessionStreams[id]
    }

    public init(connection: HubConnection) {
        self.connection = connection
    }

    private var listeningTask: Task<Void, Never>?

    /// Start listening for incoming messages. Safe to call multiple times --
    /// previous listener is cancelled.
    public func startListening() {
        log.info("startListening called")
        listeningTask?.cancel()
        listeningTask = Task { @MainActor in
            let stream = connection.incomingMessages()
            do {
                for try await message in stream {
                    log.debug("dispatch message: \(String(describing: message), privacy: .public)")
                    handleMessage(message)
                }
                log.info("message stream ended")
            } catch {
                log.error("message stream errored: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // MARK: - Commands

    public func startSession(machineId: String, directory: String, prompt: String) async throws {
        try await connection.startSession(machineId: machineId, directory: directory, prompt: prompt)
    }

    public func sendPrompt(prompt: String) async throws {
        guard let id = selectedSessionId else { return }
        try await connection.sendPrompt(sessionId: id, prompt: prompt)
    }

    public func respondToPrompt(promptId: String, response: UserPromptResponse) async throws {
        guard let id = selectedSessionId else { return }
        try await connection.respondToPrompt(sessionId: id, promptId: promptId, response: response)
    }

    public func loadSessionHistory(sessionId: String) async throws {
        try await connection.requestSessionHistory(sessionId: sessionId)
    }

    public func deleteSession(sessionId: String) async throws {
        try await connection.deleteSession(sessionId: sessionId)
    }

    /// Make sure a `SessionStream` exists for `sessionId` (so the detail
    /// view has something to render immediately) and kick off a history
    /// request. Safe to call multiple times -- it does nothing if the
    /// stream already has entries.
    private func ensureStreamAndLoadHistory(sessionId: String) {
        let stream = streamFor(sessionId)
        guard stream.entries.isEmpty else { return }
        Task { [weak self] in
            do {
                try await self?.loadSessionHistory(sessionId: sessionId)
            } catch {
                self?.lastError = HubErrorToast(
                    message: "Failed to load session history: \(error.localizedDescription)",
                )
            }
        }
    }

    // MARK: - Message dispatch

    public func handleMessage(_ message: ServerMessage) {
        switch message {
        case .sessionList(let list):
            sessions = list
            // Evict streams for sessions no longer in the list
            let liveIds = Set(list.map(\.sessionId))
            sessionStreams = sessionStreams.filter { liveIds.contains($0.key) }
            // Clear selection if the selected session was removed (e.g.
            // deleted from another client). Avoids the detail view
            // pointing at a phantom session.
            if let selected = selectedSessionId, !liveIds.contains(selected) {
                selectedSessionId = nil
            }

        case .machineList(let list):
            log.info("machine_list received with \(list.count, privacy: .public) machine(s)")
            machines = list

        case .streamText(let sessionId, let content):
            streamFor(sessionId).appendText(content)

        case .toolCall(let sessionId, let toolCallId, let toolName, let display):
            streamFor(sessionId).addToolCall(toolCallId: toolCallId, toolName: toolName, display: display)

        case .toolResult(let sessionId, let toolCallId, let content):
            streamFor(sessionId).addToolResult(toolCallId: toolCallId, content: content)

        case .userPrompt(let payload):
            streamFor(payload.sessionId).setPendingPrompt(payload)

        case .sessionStatus(let sessionId, let status, let preview):
            updateSession(sessionId) {
                $0.status = status
                if let preview { $0.lastMessagePreview = preview }
            }
            let stream = streamFor(sessionId)
            let wasGenerating = stream.status == .running
            stream.status = status
            if wasGenerating && status != .running {
                stream.flushTurn()
            }

        case .sessionDone(let payload):
            updateSession(payload.sessionId) { $0.status = .idle }
            let stream = streamFor(payload.sessionId)
            stream.status = .idle
            stream.flushTurn()

        case .sessionError(let sessionId, let error):
            updateSession(sessionId) { $0.status = .error }
            streamFor(sessionId).addError(error)

        case .sessionHistory(let sessionId, _, let messages, let error):
            streamFor(sessionId).loadHistory(messages, error: error)

        case .error(let message):
            log.error("hub error: \(message, privacy: .public)")
            lastError = HubErrorToast(message: message)
        }
    }

    private func updateSession(_ id: String, _ mutate: (inout SessionMeta) -> Void) {
        guard let idx = sessions.firstIndex(where: { $0.sessionId == id }) else { return }
        mutate(&sessions[idx])
    }

    private func streamFor(_ sessionId: String) -> SessionStream {
        if let existing = sessionStreams[sessionId] {
            return existing
        }
        let stream = SessionStream(sessionId: sessionId)
        sessionStreams[sessionId] = stream
        return stream
    }
}
