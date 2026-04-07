import SwiftUI
import CCApp

struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.isAuthenticated {
                mainContent
            } else {
                AuthView()
            }
        }
        // Surface hub-side errors to the user instead of dropping them on
        // the floor. Driven by `AppState.lastError`; cleared when the
        // user dismisses the alert.
        .alert(
            "Hub error",
            isPresented: Binding(
                get: { appState.lastError != nil },
                set: { showing in if !showing { appState.lastError = nil } },
            ),
            presenting: appState.lastError,
        ) { _ in
            Button("OK", role: .cancel) { appState.lastError = nil }
        } message: { toast in
            Text(toast.message)
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        #if os(macOS)
        NavigationSplitView {
            SessionListView()
        } detail: {
            if appState.selectedSession != nil {
                SessionDetailView()
            } else {
                ContentUnavailableView("No Session Selected", systemImage: "terminal", description: Text("Select a session from the sidebar or create a new one."))
            }
        }
        #else
        NavigationStack {
            SessionListView()
        }
        #endif
    }
}
