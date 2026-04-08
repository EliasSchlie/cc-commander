import Foundation
import Observation
import CCLog
import CCModels
import CCNetworking

private let log = CCLog.Logger("AppState")

/// A transient error surfaced from the hub (or a local action) so the UI
/// can show it to the user instead of swallowing it. Each instance gets
/// a fresh UUID so SwiftUI's `alert(item:)` re-fires even when two
/// consecutive errors carry identical text.
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
            guard let id = selectedSessionId, oldValue != id else { return }
            ensureStreamAndLoadHistory(sessionId: id)
        }
    }
    public var sessionStreams: [String: SessionStream] = [:]

    /// Most recent hub error, displayed as an alert at the root view and
    /// cleared on dismiss. Mutated only via `recordError(_:)`.
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
                    log.debug("dispatch message", ["msg": .string(String(describing: message))])
                    handleMessage(message)
                }
                log.info("message stream ended")
            } catch {
                log.error("message stream errored", ["error": .string(String(describing: error))])
            }
        }
    }

    // MARK: - Commands

    public func startSession(machineId: String, directory: String, prompt: String) async throws {
        try await connection.startSession(machineId: machineId, directory: directory, prompt: prompt)
    }

    public func sendPrompt(prompt: String) async throws {
        guard let id = selectedSessionId else { return }
        // Optimistic render -- see `SessionStream.addUserMessage` for why.
        streamFor(id).addUserMessage(prompt)
        do {
            try await connection.sendPrompt(sessionId: id, prompt: prompt)
        } catch {
            // InputBarView swallows the throw via `try?`, so surface the
            // failure here or the user gets no feedback at all.
            recordError("Failed to send: \(error.localizedDescription)")
            throw error
        }
    }

    public func respondToPrompt(promptId: String, response: UserPromptResponse) async throws {
        guard let id = selectedSessionId else { return }
        try await connection.respondToPrompt(sessionId: id, promptId: promptId, response: response)
    }

    public func loadSessionHistory(sessionId: String) async throws {
        try await connection.requestSessionHistory(sessionId: sessionId)
    }

    public func archiveSession(sessionId: String) async throws {
        try await connection.archiveSession(sessionId: sessionId)
    }

    /// Panic button: revoke all tokens and kick all sessions on this
    /// account. Forwards to `HubConnection.panic()`, which also calls
    /// `logout()` so local state returns to the auth screen on success.
    public func panic() async throws {
        try await connection.panic()
    }

    public func recordError(_ message: String) {
        lastError = HubErrorToast(message: message)
    }

    private func ensureStreamAndLoadHistory(sessionId: String) {
        let stream = streamFor(sessionId)
        guard stream.entries.isEmpty else { return }
        Task { [weak self] in
            do {
                try await self?.loadSessionHistory(sessionId: sessionId)
            } catch {
                self?.recordError("Failed to load session history: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Message dispatch

    public func handleMessage(_ message: ServerMessage) {
        switch message {
        case .sessionList(let list):
            sessions = list
            let liveIds = Set(list.map(\.sessionId))
            sessionStreams = sessionStreams.filter { liveIds.contains($0.key) }
            if let selected = selectedSessionId, !liveIds.contains(selected) {
                selectedSessionId = nil
            }

        case .machineList(let list):
            log.info("machine_list received", ["count": .int(list.count)])
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
                stream.flushPendingText()
            }

        case .sessionDone(let payload):
            updateSession(payload.sessionId) { $0.status = .idle }
            let stream = streamFor(payload.sessionId)
            stream.status = .idle
            stream.flushPendingText()

        case .sessionError(let sessionId, let error):
            updateSession(sessionId) { $0.status = .error }
            streamFor(sessionId).addError(error)

        case .sessionHistory(let sessionId, _, let messages, let error):
            streamFor(sessionId).loadHistory(messages, error: error)

        case .error(let message):
            log.error("hub error", ["message": .string(message)])
            recordError(message)
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
