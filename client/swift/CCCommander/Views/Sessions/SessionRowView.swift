import SwiftUI
import CCModels
import CCApp

struct SessionRowView: View {
    let session: SessionMeta
    let machineName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.directory)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                StatusBadge(status: session.status)
            }

            HStack {
                Label(machineName, systemImage: "desktopcomputer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(session.lastActivity, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if !session.lastMessagePreview.isEmpty {
                Text(session.lastMessagePreview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: SessionStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(statusLabel)
                .font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(statusColor.opacity(0.1), in: Capsule())
    }

    private var statusColor: Color {
        switch status {
        case .running: return .blue
        case .idle: return .green
        case .waitingForInput: return .orange
        case .error: return .red
        }
    }

    private var statusLabel: String {
        switch status {
        case .running: return "Running"
        case .idle: return "Idle"
        case .waitingForInput: return "Waiting"
        case .error: return "Error"
        }
    }
}
