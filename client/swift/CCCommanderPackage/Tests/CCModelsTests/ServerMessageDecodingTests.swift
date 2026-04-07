import Testing
import Foundation
@testable import CCModels

@Suite("ServerMessage decoding")
struct ServerMessageDecodingTests {

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    // Prevents: session list not parsed, app shows empty state
    @Test func decodesSessionList() throws {
        let json = """
        {
            "type": "session_list",
            "sessions": [{
                "sessionId": "s1",
                "accountId": "a1",
                "machineId": "m1",
                "directory": "/home/user/project",
                "status": "running",
                "lastActivity": "2026-04-05T10:00:00Z",
                "lastMessagePreview": "Working on tests...",
                "createdAt": "2026-04-05T09:00:00Z"
            }]
        }
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionList(let sessions) = msg else {
            Issue.record("Expected sessionList, got \\(msg)")
            return
        }
        #expect(sessions.count == 1)
        #expect(sessions[0].sessionId == "s1")
        #expect(sessions[0].directory == "/home/user/project")
        #expect(sessions[0].status == .running)
    }

    // Prevents: machine list ignored, user can't see online machines
    @Test func decodesMachineList() throws {
        let json = """
        {
            "type": "machine_list",
            "machines": [{
                "machineId": "m1",
                "name": "MacBook Pro",
                "online": true,
                "lastSeen": "2026-04-05T10:00:00Z"
            }]
        }
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .machineList(let machines) = msg else {
            Issue.record("Expected machineList, got \\(msg)")
            return
        }
        #expect(machines.count == 1)
        #expect(machines[0].name == "MacBook Pro")
        #expect(machines[0].online == true)
    }

    // Prevents: streaming text not displayed, user sees blank session
    @Test func decodesStreamText() throws {
        let json = """
        {"type": "stream_text", "sessionId": "s1", "content": "Hello world"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .streamText(let sessionId, let content) = msg else {
            Issue.record("Expected streamText, got \\(msg)")
            return
        }
        #expect(sessionId == "s1")
        #expect(content == "Hello world")
    }

    // Prevents: tool calls invisible during generation
    @Test func decodesToolCall() throws {
        let json = """
        {"type": "tool_call", "sessionId": "s1", "toolCallId": "tc_abc", "toolName": "Read", "display": "Reading file.swift"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .toolCall(let sid, let tcId, let name, let display) = msg else {
            Issue.record("Expected toolCall, got \\(msg)")
            return
        }
        #expect(sid == "s1")
        #expect(tcId == "tc_abc")
        #expect(name == "Read")
        #expect(display == "Reading file.swift")
    }

    // Prevents: tool results not shown
    @Test func decodesToolResult() throws {
        let json = """
        {"type": "tool_result", "sessionId": "s1", "toolCallId": "tc_abc", "content": "file contents here"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .toolResult(let sid, let tcId, let content) = msg else {
            Issue.record("Expected toolResult, got \\(msg)")
            return
        }
        #expect(sid == "s1")
        #expect(tcId == "tc_abc")
        #expect(content == "file contents here")
    }

    // Prevents: user prompts not displayed, session hangs waiting for input
    @Test func decodesUserPrompt() throws {
        let json = """
        {
            "type": "user_prompt",
            "sessionId": "s1",
            "promptId": "p1",
            "toolName": "AskUserQuestion",
            "questions": [{
                "question": "Which approach?",
                "header": "Design",
                "options": [{"label": "Option A"}, {"label": "Option B"}],
                "multiSelect": false
            }],
            "title": "Choose an approach"
        }
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .userPrompt(let payload) = msg else {
            Issue.record("Expected userPrompt, got \\(msg)")
            return
        }
        #expect(payload.sessionId == "s1")
        #expect(payload.promptId == "p1")
        #expect(payload.toolName == "AskUserQuestion")
        #expect(payload.questions?.count == 1)
        #expect(payload.questions?[0].options?.count == 2)
        #expect(payload.title == "Choose an approach")
    }

    // Prevents: user prompt without questions (permission prompts) crashes
    @Test func decodesUserPromptWithoutQuestions() throws {
        let json = """
        {
            "type": "user_prompt",
            "sessionId": "s1",
            "promptId": "p2",
            "toolName": "PermissionTool",
            "input": {"action": "delete_file", "path": "/tmp/test"}
        }
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .userPrompt(let payload) = msg else {
            Issue.record("Expected userPrompt, got \\(msg)")
            return
        }
        #expect(payload.questions == nil)
        #expect(payload.input != nil)
    }

    // Prevents: status changes not reflected in session list
    @Test func decodesSessionStatus() throws {
        let json = """
        {"type": "session_status", "sessionId": "s1", "status": "waiting_for_input", "lastMessagePreview": "Question asked"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionStatus(let sid, let status, let preview) = msg else {
            Issue.record("Expected sessionStatus, got \\(msg)")
            return
        }
        #expect(sid == "s1")
        #expect(status == .waitingForInput)
        #expect(preview == "Question asked")
    }

    // Prevents: session completion not detected
    @Test func decodesSessionDone() throws {
        let json = """
        {"type": "session_done", "sessionId": "s1", "sdkSessionId": "sdk1", "numTurns": 3, "durationMs": 5000, "totalCostUsd": 0.05}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionDone(let payload) = msg else {
            Issue.record("Expected sessionDone, got \\(msg)")
            return
        }
        #expect(payload.sessionId == "s1")
        #expect(payload.numTurns == 3)
        #expect(payload.totalCostUsd == 0.05)
    }

    // Prevents: session errors silently swallowed
    @Test func decodesSessionError() throws {
        let json = """
        {"type": "session_error", "sessionId": "s1", "error": "SDK crashed"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionError(let sid, let error) = msg else {
            Issue.record("Expected sessionError, got \\(msg)")
            return
        }
        #expect(sid == "s1")
        #expect(error == "SDK crashed")
    }

    // Prevents: hub errors not shown to user
    @Test func decodesError() throws {
        let json = """
        {"type": "error", "message": "Machine is offline"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .error(let message) = msg else {
            Issue.record("Expected error, got \\(msg)")
            return
        }
        #expect(message == "Machine is offline")
    }

    // Prevents: session history not loaded when switching devices
    @Test func decodesSessionHistory() throws {
        let json = """
        {"type": "session_history", "sessionId": "s1", "requestId": "r1", "messages": [{"role": "user", "content": "hello"}]}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionHistory(let sid, let rid, let messages, let error) = msg else {
            Issue.record("Expected sessionHistory, got \\(msg)")
            return
        }
        #expect(sid == "s1")
        #expect(rid == "r1")
        #expect(messages.count == 1)
        #expect(error == nil)
    }

    // Prevents: degraded session_history reply being indistinguishable
    // from a healthy empty one. The new optional `error` field carries
    // a stable code (timeout / no_session / fetch_failed) so the UI can
    // render "history unavailable" instead of an empty pane.
    @Test func decodesSessionHistoryWithErrorCode() throws {
        let json = """
        {"type": "session_history", "sessionId": "s1", "requestId": "r1", "messages": [], "error": "timeout"}
        """.data(using: .utf8)!

        let msg = try decoder.decode(ServerMessage.self, from: json)
        guard case .sessionHistory(_, _, let messages, let error) = msg else {
            Issue.record("Expected sessionHistory")
            return
        }
        #expect(messages.isEmpty)
        #expect(error == "timeout")
    }

    // Prevents: unknown message types crash the app
    @Test func unknownTypeThrows() {
        let json = """
        {"type": "totally_unknown", "data": 123}
        """.data(using: .utf8)!

        #expect(throws: DecodingError.self) {
            _ = try decoder.decode(ServerMessage.self, from: json)
        }
    }

    // Prevents: status enum doesn't handle all hub values
    @Test func decodesAllSessionStatuses() throws {
        for (raw, expected) in [
            ("running", SessionStatus.running),
            ("idle", SessionStatus.idle),
            ("waiting_for_input", SessionStatus.waitingForInput),
            ("error", SessionStatus.error),
        ] {
            let json = """
            {"type": "session_status", "sessionId": "s1", "status": "\(raw)"}
            """.data(using: .utf8)!
            let msg = try decoder.decode(ServerMessage.self, from: json)
            guard case .sessionStatus(_, let status, _) = msg else {
                Issue.record("Expected sessionStatus for \\(raw)")
                return
            }
            #expect(status == expected, "\\(raw) should decode to \\(expected)")
        }
    }
}
