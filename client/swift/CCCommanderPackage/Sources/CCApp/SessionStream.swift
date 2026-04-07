import Foundation
import Observation
import CCModels

/// A single entry in the session's chronological log.
public enum SessionEntry: Identifiable {
    case assistantText(id: String, text: String)
    case toolCall(id: String, toolCallId: String, toolName: String, display: String, result: String?)
    case userMessage(id: String, text: String)
    case userPromptResponse(id: String, summary: String)
    case error(id: String, message: String)

    public var id: String {
        switch self {
        case .assistantText(let id, _): return id
        case .toolCall(let id, _, _, _, _): return id
        case .userMessage(let id, _): return id
        case .userPromptResponse(let id, _): return id
        case .error(let id, _): return id
        }
    }

    /// Set the result on a `.toolCall` entry. No-op for other cases.
    mutating func setResult(_ content: String) {
        if case .toolCall(let id, let tcId, let name, let display, _) = self {
            self = .toolCall(id: id, toolCallId: tcId, toolName: name, display: display, result: content)
        }
    }
}

/// Per-session live state. Accumulates streaming events into a chronological log.
@MainActor
@Observable
public final class SessionStream {
    public let sessionId: String
    public var entries: [SessionEntry] = []

    /// Live, in-progress assistant text from the current `stream_text` deltas.
    /// Read by a dedicated sub-view so per-token mutation does not invalidate
    /// the parent ForEach over `entries`.
    public var pendingText: String = ""

    public var status: SessionStatus = .idle
    public var pendingPrompt: UserPromptPayload?

    /// Index in `entries` where the current turn began. Tool calls at or after
    /// this index are considered part of the current (in-progress) turn and
    /// rendered expanded; earlier ones are collapsed by default.
    public var currentTurnStartIndex: Int = 0

    public var isGenerating: Bool { status == .running }

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    public func appendText(_ text: String) {
        // String.append is amortized O(1) (exponential capacity growth) when
        // uniquely referenced. += compiles to the same op.
        pendingText += text
    }

    public func addToolCall(toolCallId: String, toolName: String, display: String) {
        flushPendingText()
        entries.append(.toolCall(
            id: UUID().uuidString,
            toolCallId: toolCallId,
            toolName: toolName,
            display: display,
            result: nil
        ))
    }

    public func addToolResult(toolCallId: String, content: String) {
        guard let idx = entries.lastIndex(where: {
            if case .toolCall(_, let tcId, _, _, _) = $0 { return tcId == toolCallId }
            return false
        }) else {
            // Protocol violation: log so orphan results aren't silently swallowed.
            print("[SessionStream] tool_result for unknown toolCallId: \(toolCallId)")
            return
        }
        entries[idx].setResult(content)
    }

    public func setPendingPrompt(_ payload: UserPromptPayload) {
        flushPendingText()
        pendingPrompt = payload
    }

    public func clearPendingPrompt(summary: String) {
        pendingPrompt = nil
        entries.append(.userPromptResponse(id: UUID().uuidString, summary: summary))
    }

    public func addError(_ message: String) {
        flushPendingText()
        entries.append(.error(id: UUID().uuidString, message: message))
    }

    public func flushTurn() {
        flushPendingText()
        currentTurnStartIndex = entries.count
    }

    public func loadHistory(_ messages: [AnyCodable]) {
        for msg in messages {
            if case .dictionary(let dict) = msg {
                if case .string(let role) = dict["role"], case .string(let content) = dict["content"] {
                    let id = UUID().uuidString
                    if role == "user" {
                        entries.append(.userMessage(id: id, text: content))
                    } else if role == "assistant" {
                        entries.append(.assistantText(id: id, text: content))
                    }
                }
            }
        }
        currentTurnStartIndex = entries.count
    }

    // MARK: - Private

    private func flushPendingText() {
        guard !pendingText.isEmpty else { return }
        entries.append(.assistantText(id: UUID().uuidString, text: pendingText))
        pendingText = ""
    }
}
