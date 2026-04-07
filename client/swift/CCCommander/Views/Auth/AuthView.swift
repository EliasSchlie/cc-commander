import SwiftUI
import CCApp

struct AuthView: View {
    @Environment(AppState.self) private var appState
    @State private var email = ""
    @State private var password = ""
    @State private var isRegistering = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 8) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.tint)
                Text("CC Commander")
                    .font(.largeTitle.bold())
                Text("Control Claude Code sessions across your machines")
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 16) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                    .textFieldStyle(.roundedBorder)

                SecureField("Password", text: $password)
                    .textContentType(isRegistering ? .newPassword : .password)
                    .textFieldStyle(.roundedBorder)

                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }

                Button(action: submit) {
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text(isRegistering ? "Create Account" : "Sign In")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(email.isEmpty || password.isEmpty || isLoading)
                .keyboardShortcut(.return)

                Button(isRegistering ? "Already have an account? Sign In" : "Don't have an account? Create one") {
                    isRegistering.toggle()
                    errorMessage = nil
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
            .frame(maxWidth: 300)

            Spacer()
        }
        .padding()
    }

    private func submit() {
        isLoading = true
        errorMessage = nil
        Task {
            // Subscribe BEFORE the login call. login() opens the
            // WebSocket, and the hub immediately auto-pushes
            // session_list and machine_list on connect. If we attach
            // the subscriber after that, those messages are dropped
            // (yielded into a nil continuation) and the user sees an
            // empty machine list until something else happens.
            appState.startListening()
            do {
                if isRegistering {
                    try await appState.connection.register(email: email, password: password)
                } else {
                    try await appState.connection.login(email: email, password: password)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
