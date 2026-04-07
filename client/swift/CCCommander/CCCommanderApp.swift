import SwiftUI
import CCNetworking
import CCApp

@main
struct CCCommanderApp: App {
    @State private var appState = AppState(
        connection: HubConnection(baseURL: Self.hubBaseURL)
    )

    /// Reads HUB_BASE_URL from Info.plist (set via build settings) or
    /// falls back to localhost for development. See issue #10.
    private static var hubBaseURL: URL {
        if let urlString = Bundle.main.object(forInfoDictionaryKey: "HUB_BASE_URL") as? String,
           let url = URL(string: urlString) {
            return url
        }
        return URL(string: "http://localhost:3000")!
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}
