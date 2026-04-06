import SwiftUI
import CCModels
import CCApp

struct SessionListView: View {
    @Environment(AppState.self) private var appState
    @State private var showingNewSession = false
    @State private var filterStatus: SessionStatus?
    @State private var filterMachine: String?

    var filteredSessions: [SessionMeta] {
        appState.sortedSessions.filter { session in
            if let status = filterStatus, session.status != status { return false }
            if let machine = filterMachine, session.machineId != machine { return false }
            return true
        }
    }

    var body: some View {
        List(filteredSessions, selection: Bindable(appState).selectedSessionId) { session in
            #if os(macOS)
            SessionRowView(session: session, machineName: machineName(for: session))
                .tag(session.sessionId)
            #else
            NavigationLink(value: session.sessionId) {
                SessionRowView(session: session, machineName: machineName(for: session))
            }
            #endif
        }
        #if os(iOS)
        .navigationDestination(for: String.self) { sessionId in
            SessionDetailView()
                .onAppear { appState.selectedSessionId = sessionId }
        }
        #endif
        .navigationTitle("Sessions")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }
                .keyboardShortcut("n")
            }

            #if os(macOS)
            ToolbarItem(placement: .automatic) {
                Menu {
                    Button("All") { filterStatus = nil }
                    Divider()
                    Button("Running") { filterStatus = .running }
                    Button("Idle") { filterStatus = .idle }
                    Button("Waiting") { filterStatus = .waitingForInput }
                    Button("Error") { filterStatus = .error }
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            #endif
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet()
        }
        .overlay {
            if filteredSessions.isEmpty {
                ContentUnavailableView {
                    Label("No Sessions", systemImage: "terminal")
                } description: {
                    Text("Start a new session to get going.")
                } actions: {
                    Button("New Session") { showingNewSession = true }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private func machineName(for session: SessionMeta) -> String {
        appState.machines.first { $0.machineId == session.machineId }?.name ?? "Unknown"
    }
}
