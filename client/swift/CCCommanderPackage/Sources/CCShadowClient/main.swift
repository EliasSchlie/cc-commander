import Foundation
#if canImport(Darwin)
import Darwin
#endif
import CCModels
import CCNetworking
import CCApp

// Force line-buffered stdout so output isn't lost when piped.
setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IOLBF, 0)

// Headless driver that exercises the SAME HubConnection / AppState code the
// SwiftUI app uses, so the e2e flow can be verified end-to-end without a
// graphical session. Reads CC_COMMANDER_TEST_EMAIL/PASSWORD/HUB env vars,
// logs in, prints the bootstrap state, then exits.

@MainActor
func runShadow() async {
    let env = ProcessInfo.processInfo.environment
    guard
        let email = env["CC_COMMANDER_TEST_EMAIL"],
        let password = env["CC_COMMANDER_TEST_PASSWORD"]
    else {
        FileHandle.standardError.write(Data("missing CC_COMMANDER_TEST_EMAIL/PASSWORD\n".utf8))
        exit(2)
    }
    let hubURLString = env["CC_COMMANDER_HUB"] ?? "https://cc-commander.eliasschlie.com"
    guard let hubURL = URL(string: hubURLString) else {
        FileHandle.standardError.write(Data("invalid hub url: \(hubURLString)\n".utf8))
        exit(2)
    }

    print("[shadow] hub=\(hubURLString)")
    print("[shadow] email=\(email)")

    let connection = HubConnection(baseURL: hubURL)
    let appState = AppState(connection: connection)
    appState.startListening()

    do {
        print("[shadow] logging in…")
        try await connection.login(email: email, password: password)
        print("[shadow] login ok, state=\(connection.state)")
    } catch {
        print("[shadow] login FAILED: \(error)")
        exit(1)
    }

    // Wait for bootstrap messages (machine_list/session_list)
    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline && (appState.machines.isEmpty && appState.sessions.isEmpty) {
        try? await Task.sleep(nanoseconds: 200_000_000)
    }

    print("[shadow] state=\(connection.state)")
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
        // Test mode requires an explicit directory. Defaulting to /tmp
        // here previously caused every shadow run to leave a /tmp
        // session row in the hub DB, polluting the real user's
        // sidebar. Fail loudly instead.
        guard let dir = env["CC_COMMANDER_TEST_DIR"], !dir.isEmpty else {
            print("[shadow] FAIL: CC_COMMANDER_TEST_DIR not set")
            exit(1)
        }
        let target = appState.onlineMachines[0]
        print("[shadow] starting session on \(target.name) dir=\(dir)")
        // Snapshot the sessions that existed before we started: the
        // appState.sessions list already contains old idle/error sessions
        // from previous runs, so "any idle session" is not enough to tell
        // us our NEW session finished. Track only sessions that appear
        // after start_session.
        let knownIds = Set(appState.sessions.map(\.sessionId))
        do {
            try await appState.startSession(machineId: target.machineId, directory: dir, prompt: prompt)
        } catch {
            print("[shadow] start_session FAILED: \(error)")
            exit(1)
        }
        // Watch for our new session to finish (status != running) up to 90s
        let sessDeadline = Date().addingTimeInterval(90)
        var newSessionId: String?
        var finished: SessionMeta?
        while Date() < sessDeadline && finished == nil {
            try? await Task.sleep(nanoseconds: 250_000_000)
            for s in appState.sessions where !knownIds.contains(s.sessionId) {
                if newSessionId == nil {
                    newSessionId = s.sessionId
                    print("[shadow] new session id=\(s.sessionId) status=\(s.status)")
                }
                if s.status == .idle || s.status == .error {
                    finished = s
                }
            }
        }
        guard let done = finished else {
            print("[shadow] FAIL: session never completed (newId=\(newSessionId ?? "nil"))")
            exit(1)
        }
        print("[shadow] session \(done.sessionId) finished status=\(done.status)")
        if done.status == .error {
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
