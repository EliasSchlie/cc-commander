import Testing
import Foundation
@testable import CCModels

@Suite("ClientMessage encoding")
struct ClientMessageEncodingTests {

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private func encodeToDict(_ msg: ClientMessage) throws -> [String: Any] {
        let data = try encoder.encode(msg)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    // Prevents: start_session missing required fields, hub rejects
    @Test func encodesStartSession() throws {
        let msg = ClientMessage.startSession(machineId: "m1", directory: "/home/project", prompt: "Fix the bug")
        let dict = try encodeToDict(msg)
        #expect(dict["type"] as? String == "start_session")
        #expect(dict["machineId"] as? String == "m1")
        #expect(dict["directory"] as? String == "/home/project")
        #expect(dict["prompt"] as? String == "Fix the bug")
    }

    // Prevents: send_prompt wrong format, hub ignores follow-up
    @Test func encodesSendPrompt() throws {
        let msg = ClientMessage.sendPrompt(sessionId: "s1", prompt: "Continue")
        let dict = try encodeToDict(msg)
        #expect(dict["type"] as? String == "send_prompt")
        #expect(dict["sessionId"] as? String == "s1")
        #expect(dict["prompt"] as? String == "Continue")
    }

    // Prevents: user answer not sent, session hangs
    @Test func encodesRespondToPromptWithAnswers() throws {
        let response = UserPromptResponse.answers(["Which approach?": "Option A"])
        let msg = ClientMessage.respondToPrompt(sessionId: "s1", promptId: "p1", response: response)
        let dict = try encodeToDict(msg)
        #expect(dict["type"] as? String == "respond_to_prompt")
        #expect(dict["sessionId"] as? String == "s1")
        #expect(dict["promptId"] as? String == "p1")

        let resp = dict["response"] as! [String: Any]
        #expect(resp["kind"] as? String == "answers")
        let answers = resp["answers"] as! [String: String]
        #expect(answers["Which approach?"] == "Option A")
    }

    // Prevents: allow/deny permission not sent correctly
    @Test func encodesRespondToPromptWithAllow() throws {
        let response = UserPromptResponse.allow(updatedInput: ["path": .string("/tmp/safe")])
        let msg = ClientMessage.respondToPrompt(sessionId: "s1", promptId: "p2", response: response)
        let dict = try encodeToDict(msg)
        let resp = dict["response"] as! [String: Any]
        #expect(resp["kind"] as? String == "allow")
    }

    // Prevents: deny response missing, session waits forever
    @Test func encodesRespondToPromptWithDeny() throws {
        let response = UserPromptResponse.deny(message: "Not safe")
        let msg = ClientMessage.respondToPrompt(sessionId: "s1", promptId: "p3", response: response)
        let dict = try encodeToDict(msg)
        let resp = dict["response"] as! [String: Any]
        #expect(resp["kind"] as? String == "deny")
        #expect(resp["message"] as? String == "Not safe")
    }

    // Prevents: list requests don't include type field
    @Test func encodesListSessions() throws {
        let dict = try encodeToDict(.listSessions)
        #expect(dict["type"] as? String == "list_sessions")
        #expect(dict.count == 1) // only type field
    }

    // Prevents: list machines request missing type
    @Test func encodesListMachines() throws {
        let dict = try encodeToDict(.listMachines)
        #expect(dict["type"] as? String == "list_machines")
    }

    // Prevents: history request missing sessionId
    @Test func encodesGetSessionHistory() throws {
        let dict = try encodeToDict(.getSessionHistory(sessionId: "s1"))
        #expect(dict["type"] as? String == "get_session_history")
        #expect(dict["sessionId"] as? String == "s1")
    }
}
