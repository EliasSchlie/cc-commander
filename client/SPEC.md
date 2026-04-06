# Client

The CC Commander client app. Runs on iOS, macOS, and later as a web app.

## Principles

- Every action has a keyboard shortcut. You never have to touch the mouse.
- Every action is also accessible programmatically through a CLI or API, so agents and scripts can do anything a human can.

## Session picker

- Shows all sessions, ordered by last activity
- Each entry: machine name, directory, status (running / idle / waiting for input / error), last activity, preview of last message
- Filters: by machine, by directory, by status. More filters later.
- **Mac**: sidebar on the left, active session on the right
- **iPhone**: session list as main view, tap to open full-screen, back to return

## Session view

- Claude's text streams in live
- Tool calls and results appear chronologically
- When Claude asks a question, options appear inline -- the session waits for your response
- Any other user-interaction surfaces inline the same way
- Input bar at the bottom for follow-up messages
- During generation, everything is shown expanded. Once a turn completes, tool calls and results fold away. You can unfold any turn to see details.

## New session

1. Tap "New Session"
2. Pick a machine (shows online/offline)
3. Pick or type a directory
4. Type your prompt

## Multi-device

All clients logged into the same account see the same sessions. Start on laptop, pick up on phone. Both stay in sync.

## Platforms

- iOS and macOS (native SwiftUI, shared codebase)
- Web later (same hub API, separate client)
