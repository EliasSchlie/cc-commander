import Foundation
import CCModels
import CCNetworking
import CCApp

/// Mock data for SwiftUI previews.
enum PreviewData {
    static let machines: [MachineInfo] = [
        MachineInfo(machineId: "m1", name: "MacBook Pro", online: true, lastSeen: Date()),
        MachineInfo(machineId: "m2", name: "Mac Mini Server", online: true, lastSeen: Date()),
        MachineInfo(machineId: "m3", name: "Dev VPS", online: false, lastSeen: Date().addingTimeInterval(-3600)),
    ]

    static let sessions: [SessionMeta] = [
        SessionMeta(
            sessionId: "s1", accountId: "a1", machineId: "m1",
            directory: "~/projects/cc-commander",
            status: .running,
            lastActivity: Date(),
            lastMessagePreview: "Implementing the Swift client app...",
            createdAt: Date().addingTimeInterval(-3600)
        ),
        SessionMeta(
            sessionId: "s2", accountId: "a1", machineId: "m2",
            directory: "~/projects/my-website",
            status: .idle,
            lastActivity: Date().addingTimeInterval(-1800),
            lastMessagePreview: "Done. All tests pass.",
            createdAt: Date().addingTimeInterval(-7200)
        ),
        SessionMeta(
            sessionId: "s3", accountId: "a1", machineId: "m1",
            directory: "~/projects/dotfiles",
            status: .waitingForInput,
            lastActivity: Date().addingTimeInterval(-300),
            lastMessagePreview: "Should I proceed with the refactor?",
            createdAt: Date().addingTimeInterval(-600)
        ),
        SessionMeta(
            sessionId: "s4", accountId: "a1", machineId: "m3",
            directory: "~/projects/api-server",
            status: .error,
            lastActivity: Date().addingTimeInterval(-5400),
            lastMessagePreview: "Connection lost to machine",
            createdAt: Date().addingTimeInterval(-10800)
        ),
    ]

    static let sampleEntries: [SessionEntry] = [
        .userMessage(id: "e1", text: "Implement the Swift client app for CC Commander"),
        .assistantText(id: "e2", text: "I'll start by reading the project specs and design documents to understand the architecture."),
        .toolCall(id: "e3", toolName: "Read", display: "Reading SPEC.md", result: "# CC Commander\n> Control Claude Code sessions...", collapsed: true),
        .toolCall(id: "e4", toolName: "Read", display: "Reading DESIGN.md", result: "# Technical Design\n...", collapsed: true),
        .assistantText(id: "e5", text: "Based on the specs, I'll create a SwiftUI app with three layers: CCModels for protocol types, CCNetworking for WebSocket communication, and the main app target."),
        .toolCall(id: "e6", toolName: "Write", display: "Creating Package.swift", result: nil, collapsed: false),
        .toolCall(id: "e7", toolName: "Bash", display: "Running swift test", result: "Test run with 22 tests passed", collapsed: false),
    ]

    @MainActor static func makePreviewAppState() -> AppState {
        let keychain = MockKeychainStore()
        let mockWS = MockWebSocketClient()
        let mockAuth = MockAuthClient()
        let connection = HubConnection(
            baseURL: URL(string: "https://hub.example.com")!,
            authClient: mockAuth,
            keychain: keychain,
            wsClientFactory: { mockWS }
        )
        let state = AppState(connection: connection)
        state.sessions = sessions
        state.machines = machines
        // Create a sample stream for the first session
        if let first = sessions.first {
            let stream = SessionStream(sessionId: first.sessionId)
            stream.entries = sampleEntries
            state.sessionStreams[first.sessionId] = stream
            state.selectedSessionId = first.sessionId
        }
        return state
    }
}
