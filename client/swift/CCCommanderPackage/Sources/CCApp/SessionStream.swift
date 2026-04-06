import Foundation
import Observation
import CCModels

/// A single entry in the session's chronological log.
public enum SessionEntry: Identifiable {
    case assistantText(id: String, text: String)
    case toolCall(id: String, toolName: String, display: String, result: String?, collapsed: Bool)
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
    public var pendingText: String = ""
    public var status: SessionStatus = .idle
    public var pendingPrompt: UserPromptPayload?

    public var isGenerating: Bool { status == .running }

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    public func appendText(_ text: String) {
        pendingText += text
    }

    public func addToolCall(toolName: String, display: String) {
        flushPendingText()
        entries.append(.toolCall(
            id: UUID().uuidString,
            toolName: toolName,
            display: display,
            result: nil,
            collapsed: false
        ))
    }

    public func addToolResult(content: String) {
        guard let lastIdx = entries.lastIndex(where: {
            if case .toolCall = $0 { return true }
            return false
        }) else { return }

        if case .toolCall(let id, let name, let display, _, let collapsed) = entries[lastIdx] {
            entries[lastIdx] = .toolCall(id: id, toolName: name, display: display, result: content, collapsed: collapsed)
        }
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
        collapseToolCalls()
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
    }

    // MARK: - Private

    private func flushPendingText() {
        guard !pendingText.isEmpty else { return }
        entries.append(.assistantText(id: UUID().uuidString, text: pendingText))
        pendingText = ""
    }

    private func collapseToolCalls() {
        for i in entries.indices {
            if case .toolCall(let id, let name, let display, let result, false) = entries[i] {
                entries[i] = .toolCall(id: id, toolName: name, display: display, result: result, collapsed: true)
            }
        }
    }
}
