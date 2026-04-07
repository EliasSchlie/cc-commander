import SwiftUI
import CCModels
import CCApp

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState
    // Owned here so click-anywhere-in-chat and session-switch can refocus
    // the input. InputBarView binds to this via `@FocusState.Binding`.
    @FocusState private var inputFocused: Bool

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
                        ForEach(stream.entries) { entry in
                            // .id() is for ScrollViewReader.scrollTo --
                            // ForEach already keys by Identifiable.id.
                            SessionEntryView(entry: entry)
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical)
                    .contentShape(Rectangle())
                }
                // Click anywhere in the scroll content -> input gets focus.
                // `simultaneousGesture` lets the text-selection drag gesture
                // on child Text views still win, so the user can drag-select
                // assistant/tool output without losing click-to-focus.
                .simultaneousGesture(
                    TapGesture().onEnded { inputFocused = true }
                )
                .onChange(of: stream.entries.count) {
                    withAnimation {
                        proxy.scrollTo(stream.entries.last?.id, anchor: .bottom)
                    }
                }
            }

            Divider()

            InputBarView(isFocused: $inputFocused)
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
        // Focus the input on session entry / switch.
        .onAppear { inputFocused = true }
        .onChange(of: appState.selectedSessionId) { inputFocused = true }
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
