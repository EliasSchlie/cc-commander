import SwiftUI
import CCApp

struct SessionEntryView: View {
    let entry: SessionEntry

    var body: some View {
        switch entry {
        case .assistantText(_, let text):
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal)

        case .toolCall(_, _, let toolName, let display, let result):
            ToolCallView(toolName: toolName, display: display, result: result)

        case .userMessage(_, let text):
            HStack {
                Spacer()
                Text(text)
                    .font(.body)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    .textSelection(.enabled)
            }
            .padding(.horizontal)

        case .userPromptResponse(_, let summary):
            HStack {
                Spacer()
                Label(summary, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)

        case .error(_, let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
                .padding(.horizontal)

        case .evictionMarker(_, let droppedCount):
            CenteredCaption(
                label: Self.evictionLabel(dropped: droppedCount),
                systemImage: nil
            )

        case .historyUnavailable(_, let code):
            CenteredCaption(
                label: Self.historyUnavailableLabel(code: code),
                systemImage: "exclamationmark.triangle"
            )
        }
    }

    private static func evictionLabel(dropped: Int) -> String {
        let suffix = dropped == 1 ? "older message hidden" : "older messages hidden"
        return "\(dropped) \(suffix)"
    }

    /// Maps wire-protocol HistoryErrorCode values to user-facing copy.
    /// Centralized so a new code added in the protocol can't ship with
    /// a raw `no_session` token leaking into the UI.
    private static func historyUnavailableLabel(code: String) -> String {
        switch code {
        case "timeout": return "History request timed out"
        case "no_session": return "History not yet available"
        case "fetch_failed": return "Could not load history"
        default: return "History unavailable"
        }
    }
}

/// Shared style for centered, secondary-color caption rows used by the
/// observability sentinels (eviction marker + degraded history).
private struct CenteredCaption: View {
    let label: String
    let systemImage: String?

    var body: some View {
        HStack {
            Spacer()
            if let systemImage {
                Label(label, systemImage: systemImage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal)
    }
}
