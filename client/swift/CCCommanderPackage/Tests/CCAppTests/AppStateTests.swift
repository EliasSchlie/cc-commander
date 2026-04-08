import Testing
import Foundation
@testable import CCApp
@testable import CCModels
@testable import CCNetworking

@Suite("AppState message dispatch")
@MainActor
struct AppStateTests {

    private func makeAppState() -> AppState {
        let conn = HubConnection(
            baseURL: URL(string: "https://hub.example.com")!,
            authClient: MockAuthClient(),
            keychain: MockKeychainStore(),
            wsClientFactory: { MockWebSocketClient() }
        )
        return AppState(connection: conn)
    }

    private func makeSessions() -> [SessionMeta] {
        [
            SessionMeta(sessionId: "s1", accountId: "a1", machineId: "m1",
                        directory: "/project-a", status: .running,
                        lastActivity: Date().addingTimeInterval(-100),
                        lastMessagePreview: "Working...", createdAt: Date().addingTimeInterval(-3600)),
            SessionMeta(sessionId: "s2", accountId: "a1", machineId: "m1",
                        directory: "/project-b", status: .idle,
                        lastActivity: Date(),
                        lastMessagePreview: "Done", createdAt: Date().addingTimeInterval(-7200)),
        ]
    }

    // Prevents: session list message not updating state
    @Test func sessionListUpdatesState() {
        let state = makeAppState()
        let sessions = makeSessions()
        state.handleMessage(.sessionList(sessions))
        #expect(state.sessions.count == 2)
    }

    // Prevents: sessions not sorted by last activity
    @Test func sortedSessionsOrdersByLastActivityDescending() {
        let state = makeAppState()
        let sessions = makeSessions()
        state.handleMessage(.sessionList(sessions))
        let sorted = state.sortedSessions
        #expect(sorted[0].sessionId == "s2") // more recent
        #expect(sorted[1].sessionId == "s1")
    }

    // Prevents: machine list message not updating state
    @Test func machineListUpdatesState() {
        let state = makeAppState()
        let machines = [
            MachineInfo(machineId: "m1", name: "Mac", online: true, lastSeen: Date()),
            MachineInfo(machineId: "m2", name: "VPS", online: false, lastSeen: Date()),
        ]
        state.handleMessage(.machineList(machines))
        #expect(state.machines.count == 2)
        #expect(state.onlineMachines.count == 1)
        #expect(state.offlineMachines.count == 1)
    }

    // Prevents: streaming text not dispatched to correct session stream
    @Test func streamTextDispatchesToCorrectSession() {
        let state = makeAppState()
        state.handleMessage(.streamText(sessionId: "s1", content: "Hello"))
        state.handleMessage(.streamText(sessionId: "s1", content: " world"))
        #expect(state.sessionStreams["s1"]?.pendingText == "Hello world")
        #expect(state.sessionStreams["s2"] == nil)
    }

    // Prevents: tool call not dispatched
    @Test func toolCallDispatchesToSession() {
        let state = makeAppState()
        state.handleMessage(.toolCall(sessionId: "s1", toolCallId: "tc1", toolName: "Read", display: "Reading file"))
        let stream = state.sessionStreams["s1"]
        #expect(stream?.entries.count == 1)
    }

    // Prevents: session status change not reflected in session list
    @Test func sessionStatusUpdatesSessionAndStream() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        // Set stream to running first so the transition triggers a flush
        state.sessionStreams["s1"] = SessionStream(sessionId: "s1")
        state.sessionStreams["s1"]?.status = .running

        state.handleMessage(.sessionStatus(sessionId: "s1", status: .idle, lastMessagePreview: "Finished"))

        #expect(state.sessions.first { $0.sessionId == "s1" }?.status == .idle)
        #expect(state.sessions.first { $0.sessionId == "s1" }?.lastMessagePreview == "Finished")
        #expect(state.sessionStreams["s1"]?.status == .idle)
    }

    // Prevents: session done not updating status to idle
    @Test func sessionDoneSetsStatusToIdle() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        let payload = SessionDonePayload(sessionId: "s1", sdkSessionId: "sdk1", numTurns: 3, durationMs: 5000)
        state.handleMessage(.sessionDone(payload))
        #expect(state.sessions.first { $0.sessionId == "s1" }?.status == .idle)
    }

    // Prevents: session error not reflected
    @Test func sessionErrorSetsStatusToError() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        state.handleMessage(.sessionError(sessionId: "s1", error: "Crashed"))
        #expect(state.sessions.first { $0.sessionId == "s1" }?.status == .error)
        let stream = state.sessionStreams["s1"]
        if case .error(_, let msg) = stream?.entries.last {
            #expect(msg == "Crashed")
        } else {
            Issue.record("Expected error entry")
        }
    }

    // Prevents: selecting a session doesn't return the right data
    @Test func selectedSessionReturnsCorrectSession() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        state.selectedSessionId = "s2"
        #expect(state.selectedSession?.directory == "/project-b")
    }

    // Prevents: session stream created lazily but not reused
    @Test func streamForReusesExistingStream() {
        let state = makeAppState()
        state.handleMessage(.streamText(sessionId: "s1", content: "a"))
        state.handleMessage(.streamText(sessionId: "s1", content: "b"))
        #expect(state.sessionStreams.count == 1) // only one stream created
        #expect(state.sessionStreams["s1"]?.pendingText == "ab")
    }

    // Prevents: detail view stuck on a Loading placeholder for idle
    // sessions because no inbound message ever creates a stream.
    @Test func selectingSessionEagerlyCreatesStream() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        #expect(state.sessionStreams["s1"] == nil)
        state.selectedSessionId = "s1"
        #expect(state.sessionStreams["s1"] != nil)
    }

    // Prevents: detail view pointing at a phantom session after another
    // client removes the selected row.
    @Test func sessionListClearsStaleSelection() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        state.selectedSessionId = "s1"
        let remaining = makeSessions().filter { $0.sessionId != "s1" }
        state.handleMessage(.sessionList(remaining))
        #expect(state.selectedSessionId == nil)
    }

    // Prevents: hub error messages being silently dropped instead of
    // surfaced to the user.
    @Test func errorMessageSurfacesAsToast() {
        let state = makeAppState()
        state.handleMessage(.error(message: "Machine is offline"))
        #expect(state.lastError?.message == "Machine is offline")
    }

    // Prevents: status transition out of `.running` doesn't finalize
    // partial assistant text streamed during the turn.
    @Test func statusChangeFromRunningFlushesPendingText() {
        let state = makeAppState()
        state.handleMessage(.sessionList(makeSessions()))
        let stream = SessionStream(sessionId: "s1")
        stream.status = .running
        stream.appendText("Some output")
        stream.addToolCall(toolCallId: "tc1", toolName: "Bash", display: "Running tests")
        state.sessionStreams["s1"] = stream

        state.handleMessage(.sessionStatus(sessionId: "s1", status: .idle, lastMessagePreview: nil))

        #expect(stream.pendingText.isEmpty)
    }
}
