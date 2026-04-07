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

        case .toolCall(_, let toolName, let display, let result, let collapsed):
            ToolCallView(toolName: toolName, display: display, result: result, collapsed: collapsed)

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
