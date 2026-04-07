# CC Commander

> Control Claude Code sessions across all your machines, from any device.

## What it is

An app that lets you create, manage, and interact with Claude Code sessions on any of your machines -- from your phone, your laptop, or a browser.

Sessions run on the machines where your code lives. CC Commander is the remote control.

## Clients and Machines

A **client** is something you use to interact with sessions -- your phone, your laptop, a browser tab. It runs the CC Commander app. You can't run Claude Code sessions on a client (unless it's also registered as a machine).

A **machine** is something you run Claude Code sessions on -- a VPS, a Mac Mini, your MacBook. It runs the CC Commander runner. You register it once by running a command. It doesn't need the app installed.

A MacBook might be both: it has the app (client) and can run sessions (machine). A phone might only be a client. A VPS might only be a machine.

## Hub

A central server that all clients and machines connect to. There is one hub for all users. It manages user accounts, authenticates clients, routes messages between clients and machines, and keeps session state in sync.

## Accounts

An account is a collection of clients and machines. All clients logged into the same account see the same sessions on that account's machines. You can only see sessions that were started through CC Commander.

A machine can be registered to multiple accounts. The installs are completely independent -- different accounts on the same machine don't see each other's sessions.

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

During generation, everything is shown expanded (tool calls, tool results, all of it). Once a turn completes, tool calls and results fold away -- only the assistant message and user messages stay visible. You can unfold any turn to see the details.

## New session

1. Tap "New Session"
2. Pick a machine (shows online/offline)
3. Pick or type a directory
4. Type your prompt

## Adding a machine

The app gives you a one-line command to run on the machine. The machine appears in the app within seconds.

## Multi-device

All clients logged into the same account see the same sessions. Start on laptop, pick up on phone. Both stay in sync.

## Platforms

- iOS and macOS (native SwiftUI, shared codebase)
- Web later (same API, separate client)
