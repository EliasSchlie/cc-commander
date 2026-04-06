import SwiftUI
import CCNetworking
import CCApp

@main
struct CCCommanderApp: App {
    @State private var appState = AppState(
        connection: HubConnection(baseURL: URL(string: "https://hub.cc-commander.com")!)
    )

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
