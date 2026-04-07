import SwiftUI

struct ToolCallView: View {
    let toolName: String
    let display: String
    let result: String?

    // User toggles stick; never auto-collapse on turn boundary.
    @State private var isExpanded: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                    Image(systemName: toolIcon)
                        .font(.caption)
                        .foregroundStyle(.tint)
                    Text(display)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Text(toolName)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // `result` may be an empty string when a tool produced no output;
            // skip the padded box in that case.
            if isExpanded, let result, !result.isEmpty {
                Text(result)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.leading, 18)
                    .padding(.bottom, 6)
            }
        }
        .background(Color(white: 0.5, opacity: 0.05), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 8)
    }

    private var toolIcon: String {
        switch toolName {
        case "Read": return "doc.text"
        case "Write": return "doc.text.fill"
        case "Edit": return "pencil"
        case "Bash": return "terminal"
        case "Grep": return "magnifyingglass"
        case "Glob": return "folder"
        case "Agent": return "person.2"
        default: return "wrench"
        }
    }
}
