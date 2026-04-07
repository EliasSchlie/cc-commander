import SwiftUI
import CCModels
import CCApp

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if let session = appState.selectedSession,
           let stream = appState.selectedSessionStream {
            sessionContent(session: session, stream: stream)
        } else if appState.selectedSession != nil {
            ProgressView("Loading session...")
        } else {
            ContentUnavailableView("No Session Selected", systemImage: "terminal")
        }
    }

    @ViewBuilder
    private func sessionContent(session: SessionMeta, stream: SessionStream) -> some View {
        VStack(spacing: 0) {
            // Session log
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(stream.entries) { entry in
                            SessionEntryView(entry: entry)
                                .id(entry.id)
                        }

                        // Live streaming text
                        if !stream.pendingText.isEmpty {
                            Text(stream.pendingText)
                                .font(.body)
                                .textSelection(.enabled)
                                .padding(.horizontal)
                                .id("pending-text")
                        }

                        // Pending user prompt
                        if let prompt = stream.pendingPrompt {
                            UserPromptView(prompt: prompt)
                                .id("pending-prompt")
                        }
                    }
                    .padding(.vertical)
                }
                .onChange(of: stream.entries.count) {
                    withAnimation {
                        proxy.scrollTo(stream.entries.last?.id, anchor: .bottom)
                    }
                }
                .onChange(of: stream.pendingText) {
                    if !stream.pendingText.isEmpty {
                        proxy.scrollTo("pending-text", anchor: .bottom)
                    }
                }
            }

            Divider()

            // Input bar
            InputBarView(isGenerating: stream.isGenerating)
        }
        .navigationTitle(session.directory)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .automatic) {
                StatusBadge(status: session.status)
            }
        }
        .task {
            // Load history when selecting a session
            if stream.entries.isEmpty {
                try? await appState.loadSessionHistory(sessionId: session.sessionId)
            }
        }
    }
}
