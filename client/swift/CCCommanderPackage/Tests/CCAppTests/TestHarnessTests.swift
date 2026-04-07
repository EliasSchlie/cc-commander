import Testing
import Foundation
@testable import CCApp
@testable import CCModels
@testable import CCNetworking

@Suite("TestHarness snapshot + waitFor")
@MainActor
struct TestHarnessTests {

    private func makeAppState() -> AppState {
        let conn = HubConnection(
            baseURL: URL(string: "https://hub.example.com")!,
            authClient: MockAuthClient(),
            keychain: MockKeychainStore(),
            wsClientFactory: { MockWebSocketClient() }
        )
        return AppState(connection: conn)
    }

    @Test func snapshotShapeBeforeAnyData() {
        let state = makeAppState()
        let harness = TestHarness(appState: state)
        let snap = harness.snapshot()
        #expect(snap["isAuthenticated"] as? Bool == false)
        #expect(snap["onlineMachineCount"] as? Int == 0)
        #expect((snap["machines"] as? [Any])?.count == 0)
        #expect((snap["sessions"] as? [Any])?.count == 0)
        #expect(snap["selectedSessionId"] as? String == "")
    }

    @Test func snapshotReflectsMachinesAndSessions() {
        let state = makeAppState()
        state.handleMessage(.machineList([
            MachineInfo(machineId: "m1", name: "Mac", online: true, lastSeen: Date()),
            MachineInfo(machineId: "m2", name: "VPS", online: false, lastSeen: Date()),
        ]))
        state.handleMessage(.sessionList([
            SessionMeta(sessionId: "s1", accountId: "a1", machineId: "m1",
                        directory: "/project-a", status: .idle,
                        lastActivity: Date(),
                        lastMessagePreview: "ok", createdAt: Date()),
        ]))
        state.selectedSessionId = "s1"

        let harness = TestHarness(appState: state)
        let snap = harness.snapshot()
        #expect(snap["onlineMachineCount"] as? Int == 1)
        #expect((snap["machines"] as? [Any])?.count == 2)
        #expect((snap["sessions"] as? [Any])?.count == 1)
        #expect(snap["selectedSessionId"] as? String == "s1")
    }

    @Test func waitForReturnsImmediatelyWhenPredicateAlreadyTrue() async throws {
        let state = makeAppState()
        let harness = TestHarness(appState: state)
        try await harness.waitFor("trivial", timeout: 1) { true }
    }

    @Test func waitForTimesOutAndThrows() async {
        let state = makeAppState()
        let harness = TestHarness(appState: state)
        do {
            try await harness.waitFor("never", timeout: 0.3) { false }
            Issue.record("expected timeout")
        } catch let HarnessError.timeout(label) {
            #expect(label == "never")
        } catch {
            Issue.record("expected HarnessError.timeout, got \(error)")
        }
    }

    @Test func waitForBootstrapResolvesWhenMachinesArrive() async throws {
        let state = makeAppState()
        let harness = TestHarness(appState: state)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            state.handleMessage(.machineList([
                MachineInfo(machineId: "m1", name: "Mac", online: true, lastSeen: Date()),
            ]))
        }
        try await harness.waitForBootstrap(timeout: 2)
        #expect(state.machines.count == 1)
    }

    @Test func waitForSessionStatusResolvesWhenStatusReached() async throws {
        let state = makeAppState()
        let harness = TestHarness(appState: state)
        state.handleMessage(.sessionList([
            SessionMeta(sessionId: "s1", accountId: "a1", machineId: "m1",
                        directory: "/x", status: .running,
                        lastActivity: Date(), lastMessagePreview: "",
                        createdAt: Date()),
        ]))
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            state.handleMessage(.sessionStatus(sessionId: "s1", status: .idle, lastMessagePreview: nil))
        }
        try await harness.waitForSessionStatus("s1", oneOf: [.idle, .error], timeout: 2)
        #expect(state.sessions.first?.status == .idle)
    }
}
