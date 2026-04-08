import SwiftUI
import CCModels
import CCApp

struct SessionListView: View {
    @Environment(AppState.self) private var appState
    @State private var showingNewSession = false
    @State private var filterStatus: SessionStatus?
    @State private var filterMachine: String?
    @State private var showingPanicConfirm = false

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
                .contextMenu { archiveButton(for: session) }
            #else
            NavigationLink(value: session.sessionId) {
                SessionRowView(session: session, machineName: machineName(for: session))
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                archiveButton(for: session)
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
                    ForEach(SessionStatus.allCases, id: \.self) { status in
                        Button(status.displayName) { filterStatus = status }
                    }
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            #endif

            ToolbarItem(placement: .automatic) {
                Menu {
                    Button("Panic: Kick All Devices", systemImage: "exclamationmark.triangle.fill", role: .destructive) {
                        showingPanicConfirm = true
                    }
                } label: {
                    Label("Account", systemImage: "person.circle")
                }
            }
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet()
        }
        .confirmationDialog(
            "Revoke all sessions?",
            isPresented: $showingPanicConfirm,
            titleVisibility: .visible
        ) {
            Button("Kick All Devices", role: .destructive) { triggerPanic() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will sign out every client and runner on your account and revoke all stored tokens. You will need to sign back in.")
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

    @ViewBuilder
    private func archiveButton(for session: SessionMeta) -> some View {
        Button("Archive", systemImage: "archivebox", role: .destructive) {
            archive(session)
        }
    }

    private func archive(_ session: SessionMeta) {
        Task {
            do {
                try await appState.archiveSession(sessionId: session.sessionId)
            } catch {
                appState.recordError("Failed to archive session: \(error.localizedDescription)")
            }
        }
    }

    private func triggerPanic() {
        Task {
            do {
                try await appState.panic()
            } catch {
                appState.recordError("Panic failed: \(error.localizedDescription)")
            }
        }
    }
}
