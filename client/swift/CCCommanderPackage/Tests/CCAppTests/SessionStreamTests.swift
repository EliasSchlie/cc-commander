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

    // Prevents: turn end doesn't flush partial assistant text into entries
    @Test func flushPendingTextFinalizesPartialAssistantText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("Response text")
        stream.addToolCall(toolCallId: "t1", toolName: "Read", display: "Read file")
        stream.appendText("More text")

        stream.flushPendingText()

        #expect(stream.pendingText.isEmpty)
        // Should have: assistantText, toolCall, assistantText
        #expect(stream.entries.count == 3)

        // A second flush after a new partial appends another entry
        stream.appendText("New turn text")
        stream.flushPendingText()
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

    // Prevents: typed user prompts vanish from the UI because the runner
    // never echoes them back during a live turn (only via session_history).
    @Test func addUserMessageAppendsEntryAndFlushesPendingText() {
        let stream = SessionStream(sessionId: "s1")
        stream.appendText("partial assistant ")
        stream.addUserMessage("hello there")
        #expect(stream.pendingText.isEmpty)
        #expect(stream.entries.count == 2)
        if case .assistantText(_, let text) = stream.entries[0] {
            #expect(text == "partial assistant ")
        } else {
            Issue.record("expected pending text to flush before user message")
        }
        if case .userMessage(_, let text) = stream.entries[1] {
            #expect(text == "hello there")
        } else {
            Issue.record("expected userMessage entry")
        }
    }

    // Prevents: late session_history reply duplicates optimistic entries.
    // If the user sends a prompt while history is still in flight, the
    // historical replay must be dropped to avoid out-of-order duplication.
    @Test func loadHistoryDropsReplayWhenEntriesAlreadyPopulated() {
        let stream = SessionStream(sessionId: "s1")
        stream.addUserMessage("first")
        stream.loadHistory([
            .dictionary(["role": .string("user"), "content": .string("first")]),
            .dictionary(["role": .string("assistant"), "content": .string("reply")]),
        ])
        #expect(stream.entries.count == 1)
        if case .userMessage(_, let text) = stream.entries[0] {
            #expect(text == "first")
        }
    }

    // Prevents: dropping a degraded `historyUnavailable` reply just because
    // some live events arrived first. The user must still see that history
    // could not be loaded, even when the optimistic-replay guard fires.
    @Test func loadHistoryStillSurfacesErrorMarkerWhenEntriesPopulated() {
        let stream = SessionStream(sessionId: "s1")
        stream.addUserMessage("first")
        stream.loadHistory([], error: "timeout")
        #expect(stream.entries.count == 2)
        if case .historyUnavailable(_, let code) = stream.entries[1] {
            #expect(code == "timeout")
        } else {
            Issue.record("expected historyUnavailable marker after late error reply")
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

    // Prevents: marathon sessions OOM the client because entries grows
    // unbounded -- the hub does not store history, so this array is the
    // only place a long session lives.
    //
    // Marker overhead: when overflow happens an `.evictionMarker` is
    // inserted at index 0. It does not count toward the cap, so total
    // entries.count == cap + 1 after any eviction.
    @Test func entriesAreCappedWithEviction() {
        let stream = SessionStream(sessionId: "s1")
        let cap = SessionStream.maxEntries
        // Append cap+50 errors and verify only the newest cap survive,
        // with a single coalesced marker at the head accounting for 50.
        for i in 0..<(cap + 50) {
            stream.addError("err\(i)")
        }
        #expect(stream.entries.count == cap + 1)
        if case .evictionMarker(_, let dropped) = stream.entries.first {
            #expect(dropped == 50)
        } else {
            Issue.record("first entry should be eviction marker")
        }
        if case .error(_, let firstReal) = stream.entries[1] {
            #expect(firstReal == "err50")
        } else {
            Issue.record("entries[1] should be err50 after eviction")
        }
        if case .error(_, let lastMsg) = stream.entries.last {
            #expect(lastMsg == "err\(cap + 49)")
        } else {
            Issue.record("last entry should be err\(cap + 49)")
        }
    }

    // Prevents: a marker per overflow tick instead of one running total.
    // After many sequential evictions there must still be exactly one
    // marker at index 0 with the cumulative count.
    @Test func evictionMarkerCoalesces() {
        let stream = SessionStream(sessionId: "s1")
        let cap = SessionStream.maxEntries
        // Push 3*cap entries -- 2*cap should end up dropped.
        for i in 0..<(cap * 3) {
            stream.addError("e\(i)")
        }
        let markers = stream.entries.filter {
            if case .evictionMarker = $0 { return true }
            return false
        }
        #expect(markers.count == 1)
        if case .evictionMarker(_, let dropped) = stream.entries.first {
            #expect(dropped == cap * 2)
        } else {
            Issue.record("expected single coalesced marker")
        }
        #expect(stream.entries.count == cap + 1)
    }

    // Prevents: loadHistory bypassing the entry cap (regression: the
    // initial #28 PR routed live appends through appendEntry but left
    // loadHistory's raw entries.append untouched, defeating the cap
    // for any history payload larger than maxEntries).
    @Test func loadHistoryRespectsCap() {
        let stream = SessionStream(sessionId: "s1")
        let cap = SessionStream.maxEntries
        var msgs: [AnyCodable] = []
        for i in 0..<(cap + 100) {
            msgs.append(.dictionary([
                "role": .string("user"),
                "content": .string("m\(i)"),
            ]))
        }
        stream.loadHistory(msgs)
        #expect(stream.entries.count == cap + 1)
        if case .evictionMarker(_, let dropped) = stream.entries.first {
            #expect(dropped == 100)
        } else {
            Issue.record("expected eviction marker at head")
        }
        if case .userMessage(_, let text) = stream.entries[1] {
            #expect(text == "m100")
        } else {
            Issue.record("expected userMessage m100 after eviction")
        }
    }

    // Prevents: degraded session_history reply (timeout / no_session /
    // fetch_failed) being indistinguishable from a healthy empty pane.
    // The error code becomes a `.historyUnavailable` sentinel entry.
    @Test func loadHistoryEmitsHistoryUnavailableOnError() {
        let stream = SessionStream(sessionId: "s1")
        stream.loadHistory([], error: "timeout")
        #expect(stream.entries.count == 1)
        if case .historyUnavailable(_, let code) = stream.entries.first {
            #expect(code == "timeout")
        } else {
            Issue.record("expected historyUnavailable entry")
        }
    }

    // Prevents: marker coalescing math drifting when a flushPendingText()
    // (which itself appends an entry through `appendEntry`) lands in the
    // middle of an evicting session -- the marker count must accumulate
    // across the flush instead of producing a second marker.
    @Test func evictionMarkerCoalescesAcrossFlush() {
        let stream = SessionStream(sessionId: "s1")
        let cap = SessionStream.maxEntries
        for i in 0..<(cap + 20) {
            stream.addError("e\(i)")
        }
        if case .evictionMarker(_, let droppedAfterFirst) = stream.entries.first {
            #expect(droppedAfterFirst == 20)
        } else {
            Issue.record("expected marker after first batch")
        }
        // Stream partial text and flush, so the flush actually appends an
        // entry through `appendEntry` (and triggers another overflow trim).
        stream.appendText("partial text")
        stream.flushPendingText()
        for i in 0..<30 {
            stream.addError("late\(i)")
        }
        let markers = stream.entries.filter {
            if case .evictionMarker = $0 { return true }
            return false
        }
        #expect(markers.count == 1)
        if case .evictionMarker(_, let dropped) = stream.entries.first {
            // 20 from the first batch + 1 from the flush + 30 from the
            // late batch = 51 evicted entries, all coalesced into one marker.
            #expect(dropped == 51)
        } else {
            Issue.record("expected coalesced marker")
        }
        #expect(stream.entries.count == cap + 1)
    }

    // Prevents: error sentinel being dropped when the loaded history
    // already filled the cap. The cliff marker must survive the trim.
    @Test func historyUnavailableSurvivesCap() {
        let stream = SessionStream(sessionId: "s1")
        let cap = SessionStream.maxEntries
        var msgs: [AnyCodable] = []
        for i in 0..<(cap + 10) {
            msgs.append(.dictionary([
                "role": .string("user"),
                "content": .string("m\(i)"),
            ]))
        }
        stream.loadHistory(msgs, error: "fetch_failed")
        // historyUnavailable was appended last; it must still be present.
        if case .historyUnavailable(_, let code) = stream.entries.last {
            #expect(code == "fetch_failed")
        } else {
            Issue.record("historyUnavailable should be last entry")
        }
    }

}
