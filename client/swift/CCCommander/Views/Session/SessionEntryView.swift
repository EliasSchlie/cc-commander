import SwiftUI
import CCApp

struct SessionEntryView: View {
    let entry: SessionEntry
    let isCurrentTurn: Bool

    var body: some View {
        switch entry {
        case .assistantText(_, let text):
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal)

        case .toolCall(_, _, let toolName, let display, let result):
            ToolCallView(toolName: toolName, display: display, result: result, isCurrentTurn: isCurrentTurn)

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
        }
    }
}
