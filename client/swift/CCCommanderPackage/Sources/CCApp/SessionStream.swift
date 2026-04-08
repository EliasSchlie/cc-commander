import Foundation
import Observation
import CCLog
import CCModels

/// A single entry in the session's chronological log.
public enum SessionEntry: Identifiable {
    case assistantText(id: String, text: String)
    case toolCall(id: String, toolCallId: String, toolName: String, display: String, result: String?)
    case userMessage(id: String, text: String)
    case userPromptResponse(id: String, summary: String)
    case error(id: String, message: String)
    /// Sentinel rendered at the head of `entries` after old entries were
    /// dropped to keep the cap. `droppedCount` is monotonically merged
    /// across consecutive evictions so the user sees one running total
    /// instead of a marker for every overflow tick.
    case evictionMarker(id: String, droppedCount: Int)
    /// Sentinel rendered when a `session_history` reply arrived with an
    /// `error` field set (timeout / no_session / fetch_failed). Lets the
    /// UI distinguish "no history yet" from "we tried and failed".
    case historyUnavailable(id: String, code: String)

    public var id: String {
        switch self {
        case .assistantText(let id, _): return id
        case .toolCall(let id, _, _, _, _): return id
        case .userMessage(let id, _): return id
        case .userPromptResponse(let id, _): return id
        case .error(let id, _): return id
        case .evictionMarker(let id, _): return id
        case .historyUnavailable(let id, _): return id
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
            CCLog.warn("SessionStream", "tool_result for unknown toolCallId", [
                "toolCallId": .string(toolCallId),
                "sessionId": .string(sessionId),
            ])
            return
        }
        entries[idx].setResult(content)
    }

    /// Append a user message entry from a locally-typed prompt. Called
    /// optimistically by `AppState.sendPrompt` so the user sees what they
    /// just sent immediately -- the runner does not echo user prompts back
    /// during a live turn, only via `session_history` reload.
    public func addUserMessage(_ text: String) {
        flushPendingText()
        appendEntry(.userMessage(id: UUID().uuidString, text: text))
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

    /// Finalize any in-progress streamed assistant text into a real
    /// `.assistantText` entry. Called by `AppState` when a turn ends.
    public func flushPendingText() {
        guard !pendingText.isEmpty else { return }
        appendEntry(.assistantText(id: UUID().uuidString, text: pendingText))
        pendingText = ""
    }

    public func loadHistory(_ messages: [AnyCodable], error: String? = nil) {
        // Late history reply: live events already populated entries, so
        // replaying would duplicate and reorder. Drop the messages but
        // still surface a degraded-state marker on the error path.
        guard entries.isEmpty else {
            if let code = error {
                appendEntry(.historyUnavailable(id: UUID().uuidString, code: code))
            }
            return
        }
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
        if let code = error {
            // Surface the degraded reply to the user instead of showing
            // an empty pane that's indistinguishable from "no history".
            appendEntry(.historyUnavailable(id: UUID().uuidString, code: code))
        }
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

    /// Append `entry`, evicting the oldest entries if the cap is exceeded.
    /// When eviction happens, an `.evictionMarker` is inserted/updated at
    /// the head so the user can see how many entries were dropped. The
    /// marker itself does NOT count toward `maxEntries` -- treating it as
    /// overhead keeps the cap math simple and the +1 entry is negligible
    /// against a 500-entry cap.
    private func appendEntry(_ entry: SessionEntry) {
        entries.append(entry)
        let realCount = entries.count - (hasEvictionMarker ? 1 : 0)
        let overflow = realCount - Self.maxEntries
        guard overflow > 0 else { return }

        let removeStart = hasEvictionMarker ? 1 : 0
        entries.removeSubrange(removeStart..<(removeStart + overflow))
        recordDropped(count: overflow)
    }

    private var hasEvictionMarker: Bool {
        if case .evictionMarker = entries.first { return true }
        return false
    }

    /// Insert or update the head `.evictionMarker` so consecutive trims
    /// coalesce into one running total instead of a marker per tick.
    private func recordDropped(count: Int) {
        if case .evictionMarker(let id, let prev) = entries.first {
            entries[0] = .evictionMarker(id: id, droppedCount: prev + count)
            return
        }
        entries.insert(
            .evictionMarker(id: UUID().uuidString, droppedCount: count),
            at: 0
        )
    }
}
