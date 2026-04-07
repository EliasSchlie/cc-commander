import SwiftUI
import CCModels
import CCApp

struct UserPromptView: View {
    @Environment(AppState.self) private var appState
    let prompt: UserPromptPayload
    @State private var answers: [String: String] = [:]
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
                ForEach(options, id: \.label) { option in
                    Button {
                        answers[question.question] = option.label
                    } label: {
                        HStack {
                            Text(option.label)
                            Spacer()
                            if answers[question.question] == option.label {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(answers[question.question] == option.label ? .accentColor : .secondary)
                }
            } else {
                TextField("Your answer", text: binding(for: question.question))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private func binding(for key: String) -> Binding<String> {
        Binding(
            get: { answers[key, default: ""] },
            set: { answers[key] = $0 }
        )
    }

    private func submitAnswers() {
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
            try? await appState.respondToPrompt(promptId: prompt.promptId, response: response)
            appState.selectedSessionStream?.clearPendingPrompt(summary: summary)
        }
    }
}
