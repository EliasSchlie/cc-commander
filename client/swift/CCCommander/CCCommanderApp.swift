import SwiftUI
import CCLog
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
                    CCLog.info("App", "launched", ["hubBaseURL": .string(Self.hubBaseURL.absoluteString)])

                    // If a command channel is configured, hand control over
                    // to the test harness and skip the regular launch path.
                    // The harness owns startListening + login + everything
                    // else from this point on.
                    if let cmdFile = ProcessInfo.processInfo.environment["CC_COMMANDER_CMD_FILE"], !cmdFile.isEmpty {
                        CCLog.info("App", "test command channel active", ["cmdFile": .string(cmdFile)])
                        let harness = TestHarness(appState: appState)
                        let runner = TestCommandRunner(harness: harness, path: cmdFile)
                        await runner.runUntilQuit()
                        return
                    }

                    // On launch, if we have stored tokens try to reconnect.
                    // Without this, returning users see an empty session list forever.
                    if appState.connection.hasStoredCredentials {
                        CCLog.info("App", "hasStoredCredentials=true; subscribing then connecting")
                        // Subscribe BEFORE connecting so the bootstrap
                        // machine_list / session_list pushed by the hub
                        // immediately on connect lands in our subscriber
                        // instead of being yielded into a nil continuation.
                        appState.startListening()
                        do {
                            try await appState.connection.connectWithStoredTokens()
                        } catch {
                            CCLog.error("App", "connectWithStoredTokens failed", ["error": .string(String(describing: error))])
                        }
                    } else {
                        CCLog.info("App", "hasStoredCredentials=false; AuthView will handle login")
                    }
                }
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}
