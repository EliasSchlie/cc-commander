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
        stream.addToolCall(toolName: "Read", display: "Reading file")
        #expect(stream.pendingText.isEmpty)
        #expect(stream.entries.count == 2)
        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "Some text")
        } else {
            Issue.record("Expected assistantText")
        }
        if case .toolCall(_, let name, let display, _, _) = stream.entries[1] {
            #expect(name == "Read")
            #expect(display == "Reading file")
        } else {
            Issue.record("Expected toolCall")
        }
    }

    // Prevents: tool result not attached to its tool call
    @Test func addToolResultUpdatesLastToolCall() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolCall(toolName: "Bash", display: "Running tests")
        stream.addToolResult(content: "All tests pass")
        if case .toolCall(_, _, _, let result, _) = stream.entries[0] {
            #expect(result == "All tests pass")
        } else {
            Issue.record("Expected toolCall with result")
        }
    }

    // Prevents: tool result when no tool call crashes
    @Test func addToolResultWithNoToolCallIsNoOp() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolResult(content: "orphan result")
        #expect(stream.entries.isEmpty)
    }

    // Prevents: turn end doesn't flush text, text is lost
    @Test func flushTurnFlushesPendingTextAndCollapsesToolCalls() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Response text")
        stream.addToolCall(toolName: "Read", display: "Read file")
        stream.appendText("More text")
        stream.flushTurn()

        // pendingText should be flushed
        #expect(stream.pendingText.isEmpty)

        // Tool calls should be collapsed
        for entry in stream.entries {
            if case .toolCall(_, _, _, _, let collapsed) = entry {
                #expect(collapsed == true)
            }
        }

        // Should have: assistantText, toolCall, assistantText
        #expect(stream.entries.count == 3)
    }

    // Prevents: tool calls stay expanded after generation ends
    @Test func flushTurnCollapsesAllToolCalls() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolCall(toolName: "Read", display: "File 1")
        stream.addToolCall(toolName: "Read", display: "File 2")
        stream.addToolCall(toolName: "Bash", display: "Command")

        // Before flush, all should be expanded
        for entry in stream.entries {
            if case .toolCall(_, _, _, _, let collapsed) = entry {
                #expect(collapsed == false)
            }
        }

        stream.flushTurn()

        // After flush, all should be collapsed
        for entry in stream.entries {
            if case .toolCall(_, _, _, _, let collapsed) = entry {
                #expect(collapsed == true)
            }
        }
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
