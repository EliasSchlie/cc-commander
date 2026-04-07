import SwiftUI
import CCApp

struct InputBarView: View {
    @Environment(AppState.self) private var appState
    let isGenerating: Bool
    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("Send a message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($isFocused)
                .disabled(isGenerating)
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
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isGenerating)
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .onAppear { isFocused = true }
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = trimmed
        text = ""
        Task {
            try? await appState.sendPrompt(prompt: message)
        }
    }
}
