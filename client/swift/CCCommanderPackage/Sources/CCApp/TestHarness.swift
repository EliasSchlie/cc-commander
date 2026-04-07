import Foundation
import CCLog
import CCModels
import CCNetworking

/// High-level scripted control surface that drives the *real* `AppState` +
/// `HubConnection` from outside the UI. Both `ccc-shadow` and the SwiftUI
/// app's test-mode hook share this so a Claude Code session interacts with
/// one API regardless of which front-end is running.
///
/// The harness is intentionally thin: every method maps to one user-visible
/// action and logs a structured record (`kind: "harness_action"`) before
/// and after, so a tail of `LOG_FILE` reconstructs the script unambiguously.
@MainActor
public final class TestHarness {
    public let appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    // MARK: - Auth

    public func login(email: String, password: String) async throws {
        log("login", ["email": .string(email)])
        appState.startListening()
        try await appState.connection.login(email: email, password: password)
        logResult("login", ok: true)
    }

    public func connectStored() async throws {
        log("connectStored")
        appState.startListening()
        try await appState.connection.connectWithStoredTokens()
        logResult("connectStored", ok: true)
    }

    public func logout() async {
        log("logout")
        await appState.connection.logout()
        logResult("logout", ok: true)
    }

    // MARK: - Session control

    public func startSession(machineId: String, directory: String, prompt: String) async throws {
        log("startSession", [
            "machineId": .string(machineId),
            "directory": .string(directory),
        ])
        try await appState.startSession(machineId: machineId, directory: directory, prompt: prompt)
        logResult("startSession", ok: true)
    }

    public func selectSession(_ sessionId: String) {
        log("selectSession", ["sessionId": .string(sessionId)])
        appState.selectedSessionId = sessionId
    }

    public func sendPrompt(_ prompt: String) async throws {
        log("sendPrompt")
        try await appState.sendPrompt(prompt: prompt)
        logResult("sendPrompt", ok: true)
    }

    public func respondToPrompt(promptId: String, response: UserPromptResponse) async throws {
        log("respondToPrompt", ["promptId": .string(promptId)])
        try await appState.respondToPrompt(promptId: promptId, response: response)
        logResult("respondToPrompt", ok: true)
    }

    // MARK: - Waiting

    /// Poll until `predicate` returns true or `timeout` elapses. Each tick is
    /// 100ms; the predicate runs on the main actor so it can read AppState
    /// without locks. Throws `HarnessError.timeout` on expiry so callers can
    /// surface a deterministic failure instead of "ran 30 seconds and gave up".
    public func waitFor(
        _ label: String,
        timeout: TimeInterval = 10,
        _ predicate: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        var ticks = 0
        while Date() < deadline {
            if predicate() {
                log("waitFor.ok", ["label": .string(label), "ticks": .int(ticks)])
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            ticks += 1
        }
        log("waitFor.timeout", ["label": .string(label), "timeoutSec": .double(timeout)])
        throw HarnessError.timeout(label)
    }

    public func waitForBootstrap(timeout: TimeInterval = 10) async throws {
        try await waitFor("bootstrap", timeout: timeout) {
            !self.appState.machines.isEmpty || !self.appState.sessions.isEmpty
        }
    }

    public func waitForSessionStatus(
        _ sessionId: String,
        oneOf statuses: Set<SessionStatus>,
        timeout: TimeInterval = 90
    ) async throws {
        try await waitFor("sessionStatus[\(sessionId)]", timeout: timeout) {
            guard let s = self.appState.sessions.first(where: { $0.sessionId == sessionId }) else {
                return false
            }
            return statuses.contains(s.status)
        }
    }

    // MARK: - Snapshot

    /// Serialize the entire user-visible state into a JSON-able dictionary.
    /// Callers grep / diff this in tests instead of scraping individual log
    /// lines, which keeps assertions stable when log copy changes.
    public func snapshot() -> [String: Any] {
        var dict: [String: Any] = [:]
        dict["isAuthenticated"] = appState.isAuthenticated
        dict["connectionState"] = appState.connection.state.wireName
        dict["hasStoredCredentials"] = appState.connection.hasStoredCredentials

        dict["machines"] = appState.machines.map { m -> [String: Any] in
            [
                "machineId": m.machineId,
                "name": m.name,
                "online": m.online,
            ]
        }
        dict["onlineMachineCount"] = appState.onlineMachines.count

        dict["sessions"] = appState.sortedSessions.map { s -> [String: Any] in
            [
                "sessionId": s.sessionId,
                "machineId": s.machineId,
                "directory": s.directory,
                "status": s.status.rawValue,
                "lastMessagePreview": s.lastMessagePreview,
            ]
        }

        dict["selectedSessionId"] = appState.selectedSessionId ?? ""

        if let stream = appState.selectedSessionStream {
            dict["selectedSessionStream"] = [
                "entryCount": stream.entries.count,
                "status": stream.status.rawValue,
                "hasPendingPrompt": stream.pendingPrompt != nil,
                "pendingTextLen": stream.pendingText.count,
                "lastEntryKind": Self.kindString(stream.entries.last),
            ] as [String: Any]
        }

        return dict
    }

    private static func kindString(_ entry: SessionEntry?) -> String {
        guard let entry else { return "none" }
        switch entry {
        case .assistantText: return "assistantText"
        case .toolCall: return "toolCall"
        case .userMessage: return "userMessage"
        case .userPromptResponse: return "userPromptResponse"
        case .error: return "error"
        case .evictionMarker: return "evictionMarker"
        case .historyUnavailable: return "historyUnavailable"
        }
    }

    // MARK: - Logging helpers

    private func log(_ action: String, _ fields: CCLog.Fields = [:]) {
        var record: [String: Any] = [
            "kind": "harness_action",
            "action": action,
        ]
        for (k, v) in fields {
            record[k] = unwrap(v)
        }
        CCLog.emitRecord(record)
    }

    private func logResult(_ action: String, ok: Bool, _ fields: CCLog.Fields = [:]) {
        var record: [String: Any] = [
            "kind": "harness_result",
            "action": action,
            "ok": ok,
        ]
        for (k, v) in fields {
            record[k] = unwrap(v)
        }
        CCLog.emitRecord(record)
    }

    private func unwrap(_ field: CCLog.Field) -> Any {
        switch field {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        }
    }
}

public enum HarnessError: Error, CustomStringConvertible {
    case timeout(String)
    case noSelectedSession
    case noOnlineMachine
    case unknownCommand(String)
    case badArguments(String)

    public var description: String {
        switch self {
        case .timeout(let label): return "timeout waiting for: \(label)"
        case .noSelectedSession: return "no selected session"
        case .noOnlineMachine: return "no online machine"
        case .unknownCommand(let cmd): return "unknown command: \(cmd)"
        case .badArguments(let msg): return "bad arguments: \(msg)"
        }
    }
}
