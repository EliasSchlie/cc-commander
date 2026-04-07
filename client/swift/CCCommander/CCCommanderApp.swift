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
    /// Append to a test log file when running under CC_COMMANDER_TEST_LOG.
    /// stdout/stderr aren't visible from a SwiftUI app launched via Finder
    /// or directly from the bundle, and os_log info messages don't always
    /// make it through to `log show`. A plain file is the only reliable
    /// channel for headless e2e validation.
    private static func testLog(_ message: String) {
        guard let path = ProcessInfo.processInfo.environment["CC_COMMANDER_TEST_LOG"] else { return }
        let line = "[\(Date())] \(message)\n"
        if let data = line.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
                handle.seekToEndOfFile()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                try? data.write(to: URL(fileURLWithPath: path))
            }
        }
    }

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
                    Self.testLog("RootView .task fired")
                    log.info("App launched, hubBaseURL=\(Self.hubBaseURL.absoluteString, privacy: .public)")
                    Self.testLog("App launched, hubBaseURL=\(Self.hubBaseURL.absoluteString)")
                    // Test hook: env vars trigger a programmatic login on
                    // startup so headless e2e runs can drive the real app.
                    if let email = ProcessInfo.processInfo.environment["CC_COMMANDER_TEST_EMAIL"],
                       let password = ProcessInfo.processInfo.environment["CC_COMMANDER_TEST_PASSWORD"] {
                        log.info("test mode: logging in as \(email, privacy: .public)")
                        Self.testLog("test mode: logging in as \(email)")
                        appState.startListening()
                        do {
                            try await appState.connection.login(email: email, password: password)
                            log.info("test mode login succeeded")
                            Self.testLog("test mode login succeeded")
                            // Wait briefly for messages to flow, then snapshot
                            try? await Task.sleep(nanoseconds: 5_000_000_000)
                            Self.testLog("snapshot: state=\(appState.connection.state) machines=\(appState.machines.count) online=\(appState.onlineMachines.count) sessions=\(appState.sessions.count)")
                            for m in appState.machines {
                                Self.testLog("  machine: \(m.name) online=\(m.online) id=\(m.machineId)")
                            }
                            // Optional: drive a session if a prompt was provided.
                            if let prompt = ProcessInfo.processInfo.environment["CC_COMMANDER_TEST_PROMPT"],
                               !prompt.isEmpty,
                               let target = appState.onlineMachines.first {
                                let dir = ProcessInfo.processInfo.environment["CC_COMMANDER_TEST_DIR"] ?? "/tmp"
                                let knownIds = Set(appState.sessions.map(\.sessionId))
                                Self.testLog("starting session on \(target.name) dir=\(dir)")
                                do {
                                    try await appState.startSession(machineId: target.machineId, directory: dir, prompt: prompt)
                                } catch {
                                    Self.testLog("start_session FAILED: \(error)")
                                    return
                                }
                                let deadline = Date().addingTimeInterval(90)
                                var newId: String?
                                while Date() < deadline {
                                    try? await Task.sleep(nanoseconds: 250_000_000)
                                    if let s = appState.sessions.first(where: { !knownIds.contains($0.sessionId) }) {
                                        if newId == nil {
                                            newId = s.sessionId
                                            Self.testLog("new session id=\(s.sessionId) status=\(s.status)")
                                        }
                                        if s.status == .idle || s.status == .error {
                                            Self.testLog("session \(s.sessionId) finished status=\(s.status)")
                                            return
                                        }
                                    }
                                }
                                Self.testLog("session never finished within 90s (newId=\(newId ?? "nil"))")
                            }
                        } catch {
                            log.error("test mode login failed: \(String(describing: error), privacy: .public)")
                            Self.testLog("test mode login FAILED: \(error)")
                        }
                        return
                    }
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
