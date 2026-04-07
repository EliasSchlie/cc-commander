import Testing
import Foundation
@testable import CCApp
@testable import CCModels

@Suite("SessionStream")
@MainActor
struct SessionStreamTests {

    // Prevents: streaming text not accumulated, user sees nothing
    @Test func appendTextAccumulatesPendingText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Hello ")
        stream.appendText("world")
        #expect(stream.pendingText == "Hello world")
        #expect(stream.entries.isEmpty) // not flushed yet
    }

    // Prevents: tool call appears after text instead of flushing text first
    @Test func addToolCallFlushesPendingText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Some text")
        stream.addToolCall(toolCallId: "tc1", toolName: "Read", display: "Reading file")
        #expect(stream.pendingText.isEmpty)
        #expect(stream.entries.count == 2)
        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "Some text")
        } else {
            Issue.record("Expected assistantText")
        }
        if case .toolCall(_, let tcId, let name, let display, _) = stream.entries[1] {
            #expect(tcId == "tc1")
            #expect(name == "Read")
            #expect(display == "Reading file")
        } else {
            Issue.record("Expected toolCall")
        }
    }

    // Prevents: tool result attached by position, parallel tool calls misattribute (#9)
    @Test func toolResultMatchesByToolCallId() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolCall(toolCallId: "A", toolName: "Read", display: "A")
        stream.addToolCall(toolCallId: "B", toolName: "Read", display: "B")
        // Result for A arrives AFTER B was emitted -- the parallel-tool-calls scenario
        stream.addToolResult(toolCallId: "A", content: "result-A")
        stream.addToolResult(toolCallId: "B", content: "result-B")

        if case .toolCall(_, let tcId, _, _, let result) = stream.entries[0] {
            #expect(tcId == "A")
            #expect(result == "result-A")
        } else {
            Issue.record("Expected toolCall A")
        }
        if case .toolCall(_, let tcId, _, _, let result) = stream.entries[1] {
            #expect(tcId == "B")
            #expect(result == "result-B")
        } else {
            Issue.record("Expected toolCall B")
        }
    }

    // Prevents: tool result with unknown id silently mutating wrong entry
    @Test func addToolResultWithUnknownIdIsIgnored() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolCall(toolCallId: "real", toolName: "Read", display: "x")
        stream.addToolResult(toolCallId: "ghost", content: "orphan")
        if case .toolCall(_, _, _, _, let result) = stream.entries[0] {
            #expect(result == nil)
        } else {
            Issue.record("Expected toolCall")
        }
    }

    // Prevents: turn end doesn't flush text or advance turn boundary
    @Test func flushTurnFlushesPendingTextAndAdvancesTurn() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Response text")
        stream.addToolCall(toolCallId: "t1", toolName: "Read", display: "Read file")
        stream.appendText("More text")

        stream.flushTurn()

        #expect(stream.pendingText.isEmpty)
        // Should have: assistantText, toolCall, assistantText
        #expect(stream.entries.count == 3)
        #expect(stream.currentTurnStartIndex == stream.entries.count)

        // A new turn appends past the boundary
        stream.appendText("New turn text")
        stream.flushTurn()
        #expect(stream.entries.count == 4)
    }

    // Prevents: user prompt not stored, user never sees the question
    @Test func setPendingPromptFlushesPendingText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Before prompt")
        let prompt = UserPromptPayload(
            sessionId: "s1", promptId: "p1", toolName: "AskUserQuestion",
            questions: [UserPromptQuestion(question: "Which option?")]
        )
        stream.setPendingPrompt(prompt)
        #expect(stream.pendingText.isEmpty)
        #expect(stream.pendingPrompt?.promptId == "p1")
        #expect(stream.entries.count == 1) // flushed text
    }

    // Prevents: clearing prompt doesn't record what the user chose
    @Test func clearPendingPromptAddsResponseEntry() {
        let stream = SessionStream(sessionId: "s1")
        let prompt = UserPromptPayload(
            sessionId: "s1", promptId: "p1", toolName: "AskUserQuestion"
        )
        stream.setPendingPrompt(prompt)
        stream.clearPendingPrompt(summary: "Option A")
        #expect(stream.pendingPrompt == nil)
        if case .userPromptResponse(_, let summary) = stream.entries.last {
            #expect(summary == "Option A")
        } else {
            Issue.record("Expected userPromptResponse")
        }
    }

    // Prevents: error entries not shown
    @Test func addErrorCreatesErrorEntry() {
        let stream = SessionStream(sessionId: "s1")
        stream.addError("Something broke")
        if case .error(_, let message) = stream.entries.last {
            #expect(message == "Something broke")
        } else {
            Issue.record("Expected error entry")
        }
    }

    // Prevents: error in middle of streaming text loses the text
    @Test func errorFlushesPendingText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Working")
        stream.addError("Boom")
        #expect(stream.pendingText.isEmpty)
        #expect(stream.entries.count == 2)
    }

    // Prevents: history not loaded from opaque SDK messages
    @Test func loadHistoryParsesUserAndAssistantMessages() {
        let stream = SessionStream(sessionId: "s1")
        stream.loadHistory([
            .dictionary(["role": .string("user"), "content": .string("Hello")]),
            .dictionary(["role": .string("assistant"), "content": .string("Hi there")]),
        ])
        #expect(stream.entries.count == 2)
        if case .userMessage(_, let text) = stream.entries[0] {
            #expect(text == "Hello")
        }
        if case .assistantText(_, let text) = stream.entries[1] {
            #expect(text == "Hi there")
        }
        // History counts as completed turn
        #expect(stream.currentTurnStartIndex == 2)
    }

    // Prevents #14: tool_use/tool_result blocks dropped on history reload
    @Test func loadHistoryPreservesToolCallsAndResults() {
        let stream = SessionStream(sessionId: "s1")
        stream.loadHistory([
            .dictionary([
                "role": .string("assistant"),
                "content": .array([
                    .dictionary(["type": .string("text"), "text": .string("Let me check.")]),
                    .dictionary([
                        "type": .string("tool_use"),
                        "id": .string("toolu_1"),
                        "name": .string("Bash"),
                        "input": .dictionary(["command": .string("ls")]),
                    ]),
                ]),
            ]),
            .dictionary([
                "role": .string("user"),
                "content": .array([
                    .dictionary([
                        "type": .string("tool_result"),
                        "tool_use_id": .string("toolu_1"),
                        "content": .string("file.txt"),
                    ]),
                ]),
            ]),
        ])

        #expect(stream.entries.count == 2)

        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "Let me check.")
        } else {
            Issue.record("entry 0 should be assistantText")
        }

        if case .toolCall(_, let toolCallId, let toolName, let display, let result) = stream.entries[1] {
            #expect(toolCallId == "toolu_1")
            #expect(toolName == "Bash")
            #expect(display == "$ ls")
            #expect(result == "file.txt")
        } else {
            Issue.record("entry 1 should be toolCall with result")
        }
    }

    // Prevents #14: orphan tool_result still surfaces (not silently dropped)
    @Test func loadHistoryOrphanToolResultBecomesEntry() {
        let stream = SessionStream(sessionId: "s1")
        stream.loadHistory([
            .dictionary([
                "role": .string("user"),
                "content": .array([
                    .dictionary([
                        "type": .string("tool_result"),
                        "tool_use_id": .string("toolu_orphan"),
                        "content": .array([
                            .dictionary(["type": .string("text"), "text": .string("result text")]),
                        ]),
                    ]),
                ]),
            ]),
        ])
        #expect(stream.entries.count == 1)
        if case .toolCall(_, let tcId, _, _, let result) = stream.entries[0] {
            #expect(tcId == "toolu_orphan")
            #expect(result == "result text")
        } else {
            Issue.record("orphan tool_result should produce toolCall entry")
        }
    }

    // Prevents: isGenerating not accurate during running status
    @Test func isGeneratingReflectsStatus() {
        let stream = SessionStream(sessionId: "s1")
        #expect(stream.isGenerating == false)
        stream.status = .running
        #expect(stream.isGenerating == true)
        stream.status = .idle
        #expect(stream.isGenerating == false)
    }
}
