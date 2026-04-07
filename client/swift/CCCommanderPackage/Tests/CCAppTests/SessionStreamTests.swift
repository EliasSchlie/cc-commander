import Testing
import Foundation
@testable import CCApp
@testable import CCModels

@Suite("SessionStream")
@MainActor
struct SessionStreamTests {

    // Prevents: streaming text not coalesced into a single entry, view re-layouts on every token
    @Test func appendTextCoalescesIntoSingleAssistantEntry() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Hello ")
        stream.appendText("world")
        #expect(stream.entries.count == 1)
        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "Hello world")
        } else {
            Issue.record("Expected assistantText")
        }
    }

    // Prevents: stream revision not bumped, view can't observe text growth
    @Test func appendTextBumpsStreamRevision() {
        let stream = SessionStream(sessionId: "s1")
        let before = stream.streamRevision
        stream.appendText("Hi")
        stream.appendText(" there")
        #expect(stream.streamRevision == before &+ 2)
    }

    // Prevents: tool call merging into the previous assistantText entry, ordering broken
    @Test func toolCallEndsAssistantTextRun() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Some text")
        stream.addToolCall(toolCallId: "tc1", toolName: "Read", display: "Reading file")
        stream.appendText("More text")
        #expect(stream.entries.count == 3)
        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "Some text")
        } else {
            Issue.record("Expected assistantText[0]")
        }
        if case .toolCall(_, let tcId, let name, _, _) = stream.entries[1] {
            #expect(tcId == "tc1")
            #expect(name == "Read")
        } else {
            Issue.record("Expected toolCall[1]")
        }
        if case .assistantText(_, let text) = stream.entries[2] {
            #expect(text == "More text")
        } else {
            Issue.record("Expected assistantText[2]")
        }
    }

    // Prevents: tool result attached by position, parallel tool calls misattribute
    @Test func toolResultMatchesByToolCallId() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolCall(toolCallId: "A", toolName: "Read", display: "A")
        stream.addToolCall(toolCallId: "B", toolName: "Read", display: "B")
        // Result for A arrives AFTER B was emitted -- this is the parallel-tool-calls scenario
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

    // Prevents: tool result with unknown id crashes
    @Test func addToolResultWithUnknownIdIsNoOp() {
        let stream = SessionStream(sessionId: "s1")
        stream.addToolResult(toolCallId: "ghost", content: "orphan result")
        #expect(stream.entries.isEmpty)
    }

    // Prevents: turn boundary doesn't advance, new turn's tool calls render as past
    @Test func flushTurnAdvancesCurrentTurnStartIndex() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Response text")
        stream.addToolCall(toolCallId: "t1", toolName: "Read", display: "Read file")
        stream.appendText("More text")
        #expect(stream.currentTurnStartIndex == 0)

        stream.flushTurn()
        #expect(stream.currentTurnStartIndex == stream.entries.count)
        // Should have: assistantText, toolCall, assistantText
        #expect(stream.entries.count == 3)

        // Subsequent text starts a new entry, not appended to the previous turn
        stream.appendText("New turn")
        #expect(stream.entries.count == 4)
    }

    // Prevents: user prompt not stored
    @Test func setPendingPromptStores() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Before prompt")
        let prompt = UserPromptPayload(
            sessionId: "s1", promptId: "p1", toolName: "AskUserQuestion",
            questions: [UserPromptQuestion(question: "Which option?")]
        )
        stream.setPendingPrompt(prompt)
        #expect(stream.pendingPrompt?.promptId == "p1")
        #expect(stream.entries.count == 1) // the assistantText still there
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

    // Prevents: error after open assistant text gets merged into it
    @Test func errorBreaksAssistantTextRun() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Working")
        stream.addError("Boom")
        stream.appendText("Recovering")
        #expect(stream.entries.count == 3)
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
