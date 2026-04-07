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
}

/// Per-session live state. Accumulates streaming events into a chronological log.
@MainActor
@Observable
public final class SessionStream {
    public let sessionId: String
    public var entries: [SessionEntry] = []
    public var status: SessionStatus = .idle
    public var pendingPrompt: UserPromptPayload?

    /// Index in `entries` where the current turn began. Tool calls at or after
    /// this index are considered part of the current (in-progress) turn and
    /// rendered expanded; earlier ones are collapsed by default.
    public var currentTurnStartIndex: Int = 0

    /// Bumped on each `appendText` so views can observe streaming text growth
    /// without changing `entries.count`.
    public var streamRevision: Int = 0

    public var isGenerating: Bool { status == .running }

    /// ID of the assistantText entry that the next stream_text delta should
    /// append to. Reset by tool calls and turn boundaries.
    private var openAssistantTextId: String?

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    public func appendText(_ text: String) {
        if let openId = openAssistantTextId,
           let lastIdx = entries.indices.last,
           case .assistantText(let id, let existing) = entries[lastIdx],
           id == openId {
            entries[lastIdx] = .assistantText(id: id, text: existing + text)
        } else {
            let newId = UUID().uuidString
            entries.append(.assistantText(id: newId, text: text))
            openAssistantTextId = newId
        }
        streamRevision &+= 1
    }

    public func addToolCall(toolCallId: String, toolName: String, display: String) {
        openAssistantTextId = nil
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
        }) else { return }

        if case .toolCall(let id, let tcId, let name, let display, _) = entries[idx] {
            entries[idx] = .toolCall(id: id, toolCallId: tcId, toolName: name, display: display, result: content)
        }
    }

    public func setPendingPrompt(_ payload: UserPromptPayload) {
        openAssistantTextId = nil
        pendingPrompt = payload
    }

    public func clearPendingPrompt(summary: String) {
        pendingPrompt = nil
        entries.append(.userPromptResponse(id: UUID().uuidString, summary: summary))
    }

    public func addError(_ message: String) {
        openAssistantTextId = nil
        entries.append(.error(id: UUID().uuidString, message: message))
    }

    public func flushTurn() {
        openAssistantTextId = nil
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
}
