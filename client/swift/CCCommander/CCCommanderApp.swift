import SwiftUI
import CCNetworking
import CCApp

@main
struct CCCommanderApp: App {
    @State private var appState = AppState(
        connection: HubConnection(baseURL: Self.hubBaseURL)
    )

    /// Resolves the hub base URL in priority order:
    ///   1. UserDefaults "HubBaseURL"   ← runtime override, no rebuild required
    ///   2. Info.plist HUB_BASE_URL     ← baked at build time (see project.yml)
    ///   3. http://localhost:3000       ← dev fallback
    ///
    /// Override at runtime without rebuilding:
    ///   defaults write com.cc-commander.app HubBaseURL https://hub.example.com
    ///   defaults delete com.cc-commander.app HubBaseURL  # to revert
    private static var hubBaseURL: URL {
        if let override = UserDefaults.standard.string(forKey: "HubBaseURL"),
           !override.isEmpty,
           let url = URL(string: override) {
            return url
        }
        if let urlString = Bundle.main.object(forInfoDictionaryKey: "HUB_BASE_URL") as? String,
           !urlString.isEmpty,
           !urlString.contains("$("),  // unresolved $(VAR) — treat as missing
           let url = URL(string: urlString) {
            return url
        }
        return URL(string: "http://localhost:3000")!
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .task {
                    // On launch, if we have stored tokens try to reconnect.
                    // Without this, returning users see an empty session list forever.
                    if appState.connection.hasStoredCredentials {
                        try? await appState.connection.connectWithStoredTokens()
                        appState.startListening()
                    }
                }
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}
