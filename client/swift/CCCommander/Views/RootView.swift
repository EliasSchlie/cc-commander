import SwiftUI
import CCApp

struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.isAuthenticated {
            mainContent
        } else {
            AuthView()
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
