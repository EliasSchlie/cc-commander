import SwiftUI
import CCApp

struct InputBarView: View {
    @Environment(AppState.self) private var appState
    // Focus is owned by the parent so click-anywhere-in-chat can refocus.
    @FocusState.Binding var isFocused: Bool
    @State private var text = ""

    var body: some View {
        HStack(spacing: 8) {
            // No `.disabled` -- the user can type AND send mid-generation;
            // the runner decides whether to queue or interrupt.
            TextField("Send a message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($isFocused)
                // Plain Return = send. Modified Returns fall through:
                // Shift+Return inserts a newline (multi-line field), and
                // Cmd+Return is owned by the button's keyboardShortcut --
                // re-handling it here would double-send.
                .onKeyPress(phases: .down) { press in
                    guard press.key == .return, press.modifiers.isEmpty else {
                        return .ignored
                    }
                    send()
                    return .handled
                }

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .buttonStyle(.borderless)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = trimmed
        text = ""
        // Reassert focus -- on macOS, clicking the send button steals focus
        // from the TextField even though we never lost the @FocusState bool.
        isFocused = true
        Task {
            try? await appState.sendPrompt(prompt: message)
        }
    }
}
