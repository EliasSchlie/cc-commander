import SwiftUI
import OSLog
import CCNetworking
import CCApp

private let log = Logger(subsystem: "com.cc-commander.app", category: "App")

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
                    log.info("App launched, hubBaseURL=\(Self.hubBaseURL.absoluteString, privacy: .public)")
                    // On launch, if we have stored tokens try to reconnect.
                    // Without this, returning users see an empty session list forever.
                    if appState.connection.hasStoredCredentials {
                        log.info("hasStoredCredentials=true; subscribing then connecting")
                        // Subscribe BEFORE connecting so the bootstrap
                        // machine_list / session_list pushed by the hub
                        // immediately on connect lands in our subscriber
                        // instead of being yielded into a nil continuation.
                        appState.startListening()
                        do {
                            try await appState.connection.connectWithStoredTokens()
                        } catch {
                            log.error("connectWithStoredTokens failed: \(String(describing: error), privacy: .public)")
                        }
                    } else {
                        log.info("hasStoredCredentials=false; AuthView will handle login")
                    }
                }
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}
