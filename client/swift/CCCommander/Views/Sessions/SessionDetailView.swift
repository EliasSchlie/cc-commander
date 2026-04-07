import SwiftUI
import CCModels
import CCApp

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if let session = appState.selectedSession,
           let stream = appState.selectedSessionStream {
            sessionContent(session: session, stream: stream)
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
                        ForEach(Array(stream.entries.enumerated()), id: \.element.id) { index, entry in
                            SessionEntryView(
                                entry: entry,
                                isCurrentTurn: index >= stream.currentTurnStartIndex
                            )
                            .id(entry.id)
                        }

                        // Live streaming text -- isolated in a leaf view that
                        // observes only `pendingText`, so per-token updates do
                        // not invalidate the parent ForEach over `entries`.
                        LiveStreamingTextView(stream: stream, scrollProxy: proxy)

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
    }
}

/// Renders the in-progress assistant text. Reading `stream.pendingText` here
/// (and nowhere in the parent) keeps per-token updates from invalidating the
/// outer ForEach over `entries`.
private struct LiveStreamingTextView: View {
    let stream: SessionStream
    let scrollProxy: ScrollViewProxy

    var body: some View {
        if !stream.pendingText.isEmpty {
            Text(stream.pendingText)
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal)
                .id("pending-text")
                .onChange(of: stream.pendingText) {
                    scrollProxy.scrollTo("pending-text", anchor: .bottom)
                }
        }
    }
}
