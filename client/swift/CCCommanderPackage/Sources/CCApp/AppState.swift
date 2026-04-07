import Foundation
import Observation
import CCModels
import CCNetworking

/// Canonical app state. Owns the hub connection and holds all sessions/machines.
@MainActor
@Observable
public final class AppState {
    public let connection: HubConnection

    public var sessions: [SessionMeta] = []
    public var machines: [MachineInfo] = []
    public var selectedSessionId: String?
    public var sessionStreams: [String: SessionStream] = [:]

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
        listeningTask?.cancel()
        listeningTask = Task { @MainActor in
            let stream = connection.incomingMessages()
            do {
                for try await message in stream {
                    handleMessage(message)
                }
            } catch {
                // Connection dropped
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

    // MARK: - Message dispatch

    public func handleMessage(_ message: ServerMessage) {
        switch message {
        case .sessionList(let list):
            sessions = list
            // Evict streams for sessions no longer in the list
            let liveIds = Set(list.map(\.sessionId))
            sessionStreams = sessionStreams.filter { liveIds.contains($0.key) }

        case .machineList(let list):
            machines = list

        case .streamText(let sessionId, let content):
            streamFor(sessionId).appendText(content)

        case .toolCall(let sessionId, let toolName, let display):
            streamFor(sessionId).addToolCall(toolName: toolName, display: display)

        case .toolResult(let sessionId, let content):
            streamFor(sessionId).addToolResult(content: content)

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

        case .sessionHistory(let sessionId, _, let messages):
            streamFor(sessionId).loadHistory(messages)

        case .error(let message):
            print("Hub error: \(message)")
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
