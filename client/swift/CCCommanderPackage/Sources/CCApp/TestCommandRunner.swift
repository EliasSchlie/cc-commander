import Foundation
import CCLog
import CCModels

/// File-polled command channel that lets an external Claude Code session
/// drive the running app interactively. Activated by the `CC_COMMANDER_CMD_FILE`
/// env var. The runner appends nothing -- it only reads from byte offset, so
/// the controller writes new JSON-line commands and tails `LOG_FILE` for
/// matching `harness_response` records keyed by `id`.
///
/// Why a file and not a unix socket: works on iOS sandbox, survives a GUI
/// app launching from Finder, requires no FD inheritance, and the controller
/// (a CC session) already has the `Write` and `Bash` tools to append + tail.
///
/// Command format (one JSON object per line):
///   { "id": "1", "cmd": "login", "args": { "email": "...", "password": "..." } }
///
/// Response format (also one JSON object per line) -- written via `CCLog.emitRecord`:
///   { "ts": "...", "kind": "harness_response", "id": "1", "ok": true, "result": ... }
///   { "ts": "...", "kind": "harness_response", "id": "1", "ok": false, "error": "..." }
@MainActor
public final class TestCommandRunner {
    private let harness: TestHarness
    private let path: String
    private var byteOffset: Int = 0
    private var carry: String = ""
    private var stopped: Bool = false

    public init(harness: TestHarness, path: String) {
        self.harness = harness
        self.path = path
    }

    /// Drive the runner forever (until a `quit` command lands or the file
    /// is removed). Caller picks how to bridge this into the surrounding
    /// runtime: `ccc-shadow` awaits this directly; the SwiftUI app starts
    /// it from `.task`.
    public func runUntilQuit() async {
        // Truncate the file on startup so a re-run doesn't replay stale
        // commands. The controller writes after the harness has logged
        // its "ready" record (see below), so this is race-free as long
        // as the controller follows the documented sequence in TESTING.md.
        ensureFile(truncate: true)
        emitReady()
        while !stopped {
            await pollOnce()
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        emitStopped()
    }

    private func emitReady() {
        CCLog.emitRecord([
            "kind": "harness_ready",
            "cmdFile": path,
        ])
    }

    private func emitStopped() {
        CCLog.emitRecord([
            "kind": "harness_stopped",
        ])
    }

    private func ensureFile(truncate: Bool) {
        let fm = FileManager.default
        if truncate || !fm.fileExists(atPath: path) {
            let dir = (path as NSString).deletingLastPathComponent
            if !dir.isEmpty {
                try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            }
            fm.createFile(atPath: path, contents: nil)
        }
        byteOffset = 0
        carry = ""
    }

    /// Hard cap on `carry` so a misbehaving controller that writes megabytes
    /// without a newline can't grow the buffer until OOM. 1 MiB is generous
    /// for any conceivable JSON command and small enough to bound damage.
    private static let maxCarryBytes: Int = 1 << 20

    private func pollOnce() async {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = (attrs[.size] as? NSNumber)?.intValue else {
            return
        }
        // External truncation: file shrank below our cursor. Reset and read
        // from the beginning so the next poll picks up whatever's there now.
        if size < byteOffset {
            CCLog.emitRecord([
                "kind": "harness_warning",
                "msg": "command file truncated externally; resetting offset",
                "previousOffset": byteOffset,
                "newSize": size,
            ])
            byteOffset = 0
            carry = ""
        }
        if size <= byteOffset { return }
        guard let fh = FileHandle(forReadingAtPath: path) else { return }
        defer { try? fh.close() }
        do {
            try fh.seek(toOffset: UInt64(byteOffset))
        } catch {
            return
        }
        let data = fh.readDataToEndOfFile()
        // Advance by what we actually read, not by the stat'd size: the file
        // may have grown again between stat and read, and we want the next
        // poll to pick those new bytes up rather than skipping them.
        byteOffset += data.count
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        var combined = carry + chunk
        if combined.utf8.count > Self.maxCarryBytes {
            CCLog.emitRecord([
                "kind": "harness_warning",
                "msg": "command line exceeded \(Self.maxCarryBytes) bytes without a newline; dropping carry",
            ])
            combined = ""
            carry = ""
            return
        }
        var lines = combined.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        // The last element is whatever follows the final newline -- if it's
        // empty, the chunk ended on a complete line; otherwise carry the
        // partial line until the next poll completes it.
        carry = lines.removeLast()
        for raw in lines {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            await dispatch(line: trimmed)
        }
    }

    private func dispatch(line: String) async {
        defer {
            // Flush after every command so a controller doing fast
            // write→tail can rely on `harness_response` having hit disk
            // by the time the next loop iteration starts. Without this,
            // the file sink may buffer the line and the controller
            // races the runner.
            CCLog.flush()
        }
        guard let data = line.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let obj = any as? [String: Any] else {
            CCLog.emitRecord([
                "kind": "harness_response",
                "ok": false,
                "error": "command line is not a JSON object",
                "raw": line,
            ])
            return
        }
        // Require both `id` and `cmd` -- silently substituting "" makes
        // typo'd commands look successful and untraceable.
        guard let id = obj["id"] as? String, !id.isEmpty else {
            CCLog.emitRecord([
                "kind": "harness_response",
                "ok": false,
                "error": "missing or empty 'id'",
                "raw": line,
            ])
            return
        }
        guard let cmd = obj["cmd"] as? String, !cmd.isEmpty else {
            CCLog.emitRecord([
                "kind": "harness_response",
                "id": id,
                "ok": false,
                "error": "missing or empty 'cmd'",
            ])
            return
        }
        let args = obj["args"] as? [String: Any] ?? [:]
        do {
            let result = try await execute(cmd: cmd, args: args)
            CCLog.emitRecord([
                "kind": "harness_response",
                "id": id,
                "cmd": cmd,
                "ok": true,
                "result": result,
            ])
        } catch {
            CCLog.emitRecord([
                "kind": "harness_response",
                "id": id,
                "cmd": cmd,
                "ok": false,
                "error": String(describing: error),
            ])
        }
    }

    private func execute(cmd: String, args: [String: Any]) async throws -> Any {
        switch cmd {
        case "login":
            let email = try requiredString(args, "email")
            let password = try requiredString(args, "password")
            try await harness.login(email: email, password: password)
            return ["state": "connected"]

        case "connectStored":
            try await harness.connectStored()
            return ["state": "connected"]

        case "logout":
            await harness.logout()
            return ["state": "disconnected"]

        case "startSession":
            let machineId = try requiredString(args, "machineId")
            let directory = try requiredString(args, "directory")
            let prompt = try requiredString(args, "prompt")
            let knownIds = Set(harness.appState.sessions.map(\.sessionId))
            try await harness.startSession(machineId: machineId, directory: directory, prompt: prompt)
            // Best-effort: return the new session id if one shows up within 2s
            // so the caller has something to pass to subsequent commands.
            try? await harness.waitFor("startSession.newId", timeout: 2) {
                self.harness.appState.sessions.contains { !knownIds.contains($0.sessionId) }
            }
            let newId = harness.appState.sessions.first { !knownIds.contains($0.sessionId) }?.sessionId
            return ["sessionId": newId ?? ""]

        case "selectSession":
            let id = try requiredString(args, "sessionId")
            harness.selectSession(id)
            return ["selectedSessionId": id]

        case "sendPrompt":
            let prompt = try requiredString(args, "prompt")
            try await harness.sendPrompt(prompt)
            return ["sent": true]

        case "respondToPrompt":
            let promptId = try requiredString(args, "promptId")
            guard let responseObj = args["response"] else {
                throw HarnessError.badArguments("missing 'response'")
            }
            let responseData = try JSONSerialization.data(withJSONObject: responseObj)
            let response = try JSONDecoder().decode(UserPromptResponse.self, from: responseData)
            try await harness.respondToPrompt(promptId: promptId, response: response)
            return ["sent": true]

        case "waitForBootstrap":
            let timeout = optionalDouble(args, "timeout") ?? 10
            try await harness.waitForBootstrap(timeout: timeout)
            let result: [String: Any] = [
                "machines": harness.appState.machines.count,
                "online": harness.appState.onlineMachines.count,
                "sessions": harness.appState.sessions.count,
            ]
            return result

        case "waitForSessionStatus":
            let id = try requiredString(args, "sessionId")
            let timeout = optionalDouble(args, "timeout") ?? 90
            let raw = (args["statuses"] as? [String]) ?? [
                SessionStatus.idle.rawValue,
                SessionStatus.error.rawValue,
            ]
            let parsed: [SessionStatus] = raw.compactMap { SessionStatus(rawValue: $0) }
            guard !parsed.isEmpty else { throw HarnessError.badArguments("no valid statuses in 'statuses'") }
            try await harness.waitForSessionStatus(id, oneOf: Set(parsed), timeout: timeout)
            let final = harness.appState.sessions.first { $0.sessionId == id }
            return [
                "sessionId": id,
                "status": final?.status.rawValue ?? "missing",
            ]

        case "snapshot":
            return harness.snapshot()

        case "quit":
            stopped = true
            return ["stopped": true]

        default:
            throw HarnessError.unknownCommand(cmd)
        }
    }

    private func requiredString(_ args: [String: Any], _ key: String) throws -> String {
        guard let v = args[key] as? String, !v.isEmpty else {
            throw HarnessError.badArguments("missing or empty '\(key)'")
        }
        return v
    }

    /// JSON numbers may decode as either `Int` or `Double` via
    /// `JSONSerialization` depending on whether the literal had a decimal
    /// point. `as? Double` alone fails for `"timeout": 10`, which would
    /// silently fall back to the default and confuse callers. Try both.
    private func optionalDouble(_ args: [String: Any], _ key: String) -> Double? {
        if let d = args[key] as? Double { return d }
        if let i = args[key] as? Int { return Double(i) }
        if let n = args[key] as? NSNumber { return n.doubleValue }
        return nil
    }
}
