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

    /// Hard cap on `entries`. When exceeded, oldest entries are dropped to
    /// keep memory bounded on long-running sessions. The hub does not store
    /// conversation history per spec, so the only place a long session
    /// lives is in this array -- without a cap, marathon sessions would
    /// eventually OOM the client (especially on iOS).
    public static let maxEntries: Int = 500

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
        appendEntry(.toolCall(
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
        appendEntry(.userPromptResponse(id: UUID().uuidString, summary: summary))
    }

    public func addError(_ message: String) {
        flushPendingText()
        appendEntry(.error(id: UUID().uuidString, message: message))
    }

    public func flushTurn() {
        flushPendingText()
        currentTurnStartIndex = entries.count
    }

    public func loadHistory(_ messages: [AnyCodable]) {
        for msg in messages {
            guard case .dictionary(let dict) = msg,
                  case .string(let role) = dict["role"] else { continue }

            let content = dict["content"]

            // Simple shape: content is a plain string.
            if case .string(let text) = content {
                let id = UUID().uuidString
                if role == "user" {
                    appendEntry(.userMessage(id: id, text: text))
                } else if role == "assistant" && !text.isEmpty {
                    appendEntry(.assistantText(id: id, text: text))
                }
                continue
            }

            // Block-array shape: content is [{type: "text"|"tool_use"|"tool_result", ...}]
            guard case .array(let blocks) = content else { continue }
            for block in blocks {
                guard case .dictionary(let bl) = block,
                      case .string(let type) = bl["type"] else { continue }

                switch type {
                case "text":
                    if role == "assistant", case .string(let text) = bl["text"], !text.isEmpty {
                        appendEntry(.assistantText(id: UUID().uuidString, text: text))
                    } else if role == "user", case .string(let text) = bl["text"] {
                        appendEntry(.userMessage(id: UUID().uuidString, text: text))
                    }
                case "tool_use":
                    guard case .string(let toolCallId) = bl["id"],
                          case .string(let toolName) = bl["name"] else { continue }
                    appendEntry(.toolCall(
                        id: UUID().uuidString,
                        toolCallId: toolCallId,
                        toolName: toolName,
                        display: Self.formatToolDisplay(name: toolName, input: bl["input"]),
                        result: nil
                    ))
                case "tool_result":
                    guard case .string(let toolUseId) = bl["tool_use_id"] else { continue }
                    let text = Self.extractToolResultText(bl["content"])
                    if let idx = entries.lastIndex(where: {
                        if case .toolCall(_, let tcId, _, _, _) = $0 { return tcId == toolUseId }
                        return false
                    }) {
                        entries[idx].setResult(text)
                    } else {
                        // Orphan tool_result (tool_use missing from history window).
                        // Render as a standalone toolCall so the result is still visible.
                        appendEntry(.toolCall(
                            id: UUID().uuidString,
                            toolCallId: toolUseId,
                            toolName: "(unknown tool)",
                            display: "(unknown tool)",
                            result: text
                        ))
                    }
                default:
                    continue
                }
            }
        }
        currentTurnStartIndex = entries.count
    }

    /// Mirrors the runner's `formatToolDisplay`. Kept here so reloads from
    /// history match the formatting of live tool_call events.
    private static func formatToolDisplay(name: String, input: AnyCodable?) -> String {
        guard case .dictionary(let dict) = input else { return name }
        if name == "Bash", case .string(let cmd) = dict["command"] {
            return "$ " + cmd
        }
        if case .string(let path) = dict["file_path"] {
            return name + " " + path
        }
        if case .string(let pat) = dict["pattern"] {
            return name + " " + pat
        }
        return name
    }

    private static func extractToolResultText(_ content: AnyCodable?) -> String {
        guard let content else { return "" }
        if case .string(let s) = content { return s }
        if case .array(let blocks) = content {
            return blocks.compactMap { bl -> String? in
                guard case .dictionary(let d) = bl,
                      case .string(let type) = d["type"], type == "text",
                      case .string(let text) = d["text"] else { return nil }
                return text
            }.joined(separator: "\n")
        }
        return ""
    }

    // MARK: - Private

    private func flushPendingText() {
        guard !pendingText.isEmpty else { return }
        appendEntry(.assistantText(id: UUID().uuidString, text: pendingText))
        pendingText = ""
    }

    /// Append `entry` to `entries`, evicting the oldest entries if the cap
    /// is exceeded. Adjusts `currentTurnStartIndex` so it still points at
    /// the same logical entry (or 0 if that entry was evicted).
    private func appendEntry(_ entry: SessionEntry) {
        entries.append(entry)
        let overflow = entries.count - Self.maxEntries
        if overflow > 0 {
            entries.removeFirst(overflow)
            currentTurnStartIndex = max(0, currentTurnStartIndex - overflow)
        }
    }
}
