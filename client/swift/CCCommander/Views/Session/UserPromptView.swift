import SwiftUI
import CCModels
import CCApp

struct UserPromptView: View {
    @Environment(AppState.self) private var appState
    let prompt: UserPromptPayload
    /// Selected option labels per question. Sets allow multi-select questions
    /// to track multiple selections; single-select questions hold a 1-element set.
    @State private var selections: [String: Set<String>] = [:]
    @State private var freeformAnswers: [String: String] = [:]
    @State private var isSubmitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = prompt.title {
                Text(title)
                    .font(.headline)
            }

            if let questions = prompt.questions {
                ForEach(Array(questions.enumerated()), id: \.offset) { _, question in
                    questionView(question)
                }

                Button("Submit") {
                    submitAnswers()
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSubmitting)
                .keyboardShortcut(.return)
            } else {
                // Permission prompt (no questions, has input)
                if let input = prompt.input {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Permission requested: \(prompt.toolName)")
                            .font(.callout.bold())
                        ForEach(Array(input.keys.sorted()), id: \.self) { key in
                            if case .string(let value) = input[key] {
                                Text("\(key): \(value)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    HStack {
                        Button("Allow") { submitAllow() }
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut(.return)
                        Button("Deny") { submitDeny() }
                            .buttonStyle(.bordered)
                            .keyboardShortcut(.escape)
                    }
                    .disabled(isSubmitting)
                }
            }
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
    }

    @ViewBuilder
    private func questionView(_ question: UserPromptQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = question.header {
                Text(header)
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            Text(question.question)
                .font(.callout)

            if let options = question.options {
                let isMulti = question.multiSelect ?? false
                ForEach(options, id: \.label) { option in
                    let selected = selections[question.question, default: []].contains(option.label)
                    Button {
                        toggle(option.label, in: question.question, multi: isMulti)
                    } label: {
                        HStack {
                            Text(option.label)
                            Spacer()
                            if selected {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(selected ? .accentColor : .secondary)
                }
            } else {
                TextField("Your answer", text: binding(for: question.question))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private func toggle(_ option: String, in question: String, multi: Bool) {
        var current = selections[question, default: []]
        if multi {
            if current.contains(option) {
                current.remove(option)
            } else {
                current.insert(option)
            }
        } else {
            current = [option]
        }
        selections[question] = current
    }

    private func binding(for key: String) -> Binding<String> {
        Binding(
            get: { freeformAnswers[key, default: ""] },
            set: { freeformAnswers[key] = $0 }
        )
    }

    /// Build the answers dict to send. Multi-select questions are joined with
    /// ", " (the convention used by the Claude SDK's AskUserQuestion tool).
    private func buildAnswers() -> [String: String] {
        var result: [String: String] = [:]
        guard let questions = prompt.questions else { return result }
        for q in questions {
            if q.options != nil {
                let picked = selections[q.question, default: []]
                if !picked.isEmpty {
                    result[q.question] = picked.sorted().joined(separator: ", ")
                }
            } else if let text = freeformAnswers[q.question], !text.isEmpty {
                result[q.question] = text
            }
        }
        return result
    }

    private func submitAnswers() {
        let answers = buildAnswers()
        submit(.answers(answers), summary: answers.values.joined(separator: ", "))
    }

    private func submitAllow() {
        submit(.allow(), summary: "Allowed")
    }

    private func submitDeny() {
        submit(.deny(message: "Denied by user"), summary: "Denied")
    }

    private func submit(_ response: UserPromptResponse, summary: String) {
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            do {
                try await appState.respondToPrompt(promptId: prompt.promptId, response: response)
                appState.selectedSessionStream?.clearPendingPrompt(summary: summary)
            } catch {
                // Send failed -- leave the prompt visible so user can retry.
                // isSubmitting is reset by the defer above.
            }
        }
    }
}
