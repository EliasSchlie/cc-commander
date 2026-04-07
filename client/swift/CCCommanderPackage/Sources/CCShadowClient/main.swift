import Foundation
#if canImport(Darwin)
import Darwin
#endif
import CCLog
import CCModels
import CCNetworking
import CCApp

// Force line-buffered stdout so output isn't lost when piped.
setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IOLBF, 0)

// Headless driver that exercises the SAME HubConnection / AppState code
// the SwiftUI app uses, so the e2e flow can be verified end-to-end without
// a graphical session.
//
// Two modes:
//
//   1. Interactive command channel  (CC_COMMANDER_CMD_FILE set)
//      A Claude Code session writes JSON commands to the file; ccc-shadow
//      executes them via TestHarness and writes responses to LOG_FILE.
//      See client/swift/TESTING.md for the wire format.
//
//   2. Legacy env-var smoke test    (CC_COMMANDER_TEST_EMAIL set)
//      One-shot: log in, optionally start one session, exit. Same env vars
//      that existed before the harness refactor, kept for CI back-compat.

@MainActor
func runShadow() async {
    let env = ProcessInfo.processInfo.environment
    let hubURLString = env["CC_COMMANDER_HUB"] ?? "https://cc-commander.eliasschlie.com"
    guard let hubURL = URL(string: hubURLString) else {
        FileHandle.standardError.write(Data("invalid hub url: \(hubURLString)\n".utf8))
        exit(2)
    }

    print("[shadow] hub=\(hubURLString)")
    // Use an in-memory keychain instead of the production one. The shadow
    // client is rebuilt on every `swift run`, which gives the binary a
    // new code signature each time and triggers macOS keychain "allow /
    // deny" prompts the moment we touch SecItemCopyMatching. A prompt
    // blocks the runner forever in a headless context. The in-memory
    // store has the same protocol surface so HubConnection's reconnect
    // / token-refresh paths work identically; we just lose persistence
    // across process restarts, which `ccc-shadow` doesn't need anyway.
    let connection = HubConnection(
        baseURL: hubURL,
        authClient: AuthClient(baseURL: hubURL),
        keychain: MockKeychainStore(),
        wsClientFactory: { WebSocketClient() }
    )
    let appState = AppState(connection: connection)
    let harness = TestHarness(appState: appState)

    if let cmdFile = env["CC_COMMANDER_CMD_FILE"], !cmdFile.isEmpty {
        print("[shadow] command channel mode cmdFile=\(cmdFile)")
        let runner = TestCommandRunner(harness: harness, path: cmdFile)
        await runner.runUntilQuit()
        print("[shadow] runner stopped")
        exit(0)
    }

    // Legacy one-shot smoke test.
    guard
        let email = env["CC_COMMANDER_TEST_EMAIL"],
        let password = env["CC_COMMANDER_TEST_PASSWORD"]
    else {
        FileHandle.standardError.write(Data("missing CC_COMMANDER_TEST_EMAIL/PASSWORD or CC_COMMANDER_CMD_FILE\n".utf8))
        exit(2)
    }
    print("[shadow] legacy smoke test mode email=\(email)")
    do {
        try await harness.login(email: email, password: password)
    } catch {
        print("[shadow] login FAILED: \(error)")
        exit(1)
    }

    do {
        try await harness.waitForBootstrap(timeout: 8)
    } catch {
        print("[shadow] FAIL: bootstrap timeout: \(error)")
        exit(1)
    }

    print("[shadow] machines=\(appState.machines.count) online=\(appState.onlineMachines.count) sessions=\(appState.sessions.count)")
    for m in appState.machines {
        print("  machine: \(m.name) online=\(m.online) id=\(m.machineId)")
    }

    if appState.onlineMachines.isEmpty {
        print("[shadow] FAIL: no online machines visible")
        exit(1)
    }

    // Optional: drive a session if asked
    if let prompt = env["CC_COMMANDER_TEST_PROMPT"], !prompt.isEmpty {
        // Required: a default would silently leave session rows in the shared hub DB.
        guard let dir = env["CC_COMMANDER_TEST_DIR"], !dir.isEmpty else {
            print("[shadow] FAIL: CC_COMMANDER_TEST_DIR not set")
            exit(1)
        }
        let target = appState.onlineMachines[0]
        print("[shadow] starting session on \(target.name) dir=\(dir)")
        let knownIds = Set(appState.sessions.map(\.sessionId))
        do {
            try await harness.startSession(machineId: target.machineId, directory: dir, prompt: prompt)
        } catch {
            print("[shadow] start_session FAILED: \(error)")
            exit(1)
        }
        do {
            try await harness.waitFor("newSession", timeout: 5) {
                appState.sessions.contains { !knownIds.contains($0.sessionId) }
            }
        } catch {
            print("[shadow] FAIL: new session never appeared: \(error)")
            exit(1)
        }
        guard let newId = appState.sessions.first(where: { !knownIds.contains($0.sessionId) })?.sessionId else {
            print("[shadow] FAIL: lost track of new session id")
            exit(1)
        }
        print("[shadow] new session id=\(newId)")
        do {
            try await harness.waitForSessionStatus(newId, oneOf: [.idle, .error], timeout: 90)
        } catch {
            print("[shadow] FAIL: session never completed: \(error)")
            exit(1)
        }
        let final = appState.sessions.first { $0.sessionId == newId }
        let status = final.map { String(describing: $0.status) } ?? "missing"
        print("[shadow] session \(newId) finished status=\(status)")
        if final?.status == .error {
            exit(1)
        }
    }

    print("[shadow] SUCCESS")
    exit(0)
}

// Drive runShadow on the MainActor and exit when it returns. Cannot block
// the main thread with a semaphore here -- that would deadlock the
// MainActor that runShadow wants to run on.
Task { @MainActor in
    await runShadow()
}
RunLoop.main.run()
