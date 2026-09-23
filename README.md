# agentdeck

A local workbench for running AI coding agents in parallel. Run Claude Code, Codex, Gemini CLI and other agents side by side, across projects, without them stepping on each other's working copy.

```mermaid
flowchart LR
    UI["Desktop / browser UI<br/>sessions · terminal grid · diff"]
    D["Local daemon<br/>owns every PTY"]
    UI <-->|"REST + WebSocket<br/>(127.0.0.1, token)"| D
    D --> A1["claude<br/>worktree: agentdeck/task-a"]
    D --> A2["codex<br/>worktree: agentdeck/task-b"]
    D --> A3["gemini<br/>shared project folder"]
```

## What it does

- **Isolated sessions** – each task can run in its own `git worktree` and branch, or directly in the project folder.
- **Sessions outlive the window** – agents run in a background daemon; close the app and they keep working.
- **Terminal grid** – watch and drive several agents at once; split, resize and maximize panels.
- **Know when an agent needs you** – sessions waiting for approval or input are flagged, with desktop notifications.
- **Review the work** – per-file diff of everything a session changed since it started.
- **Claude account switching** – sign in to several Claude accounts once, switch with one click from the sidebar.
- **Keyboard first** – command palette (`Ctrl+K`), `Alt+1…9` to jump between sessions, themes in settings.

## Install

Requirements: Linux, Node 22+, Git, and the agent CLIs you want to use on your `PATH`.

**One command:**

```bash
git clone https://github.com/osmntahir/agentdeck.git && cd agentdeck && npm install && npm run build && npm run install-desktop -- --desktop && npm run app
```

This also puts an **agentdeck** icon in your app menu and on your desktop; after that, open it like any other desktop app.

**Step by step:**

```bash
git clone https://github.com/osmntahir/agentdeck.git
cd agentdeck
npm install
npm run build
npm run install-desktop -- --desktop   # optional: app menu + desktop icon
npm run app                            # opens the window
```

Leave out `-- --desktop` to add it to the app menu only. If your desktop still asks before opening the icon, right-click it and choose **Allow Launching**.

Prefer the browser? Run `npm run build && npm start` and open the `http://127.0.0.1:4711/?token=…` URL it prints.

If `npm install` fails while building `node-pty`, install build tools: `sudo apt install build-essential python3`.

## Update

```bash
git pull && npm install && npm run build
```

Reload the window with `Ctrl+Shift+R`. If the server code changed, restart the daemon as well (this stops running sessions):

```bash
pkill -f dist/server/index.js; npm run app
```

## Development

```bash
npm run dev         # daemon on :4711 + Vite on :4710
npm test
npm run typecheck
```

Design decisions live in [`docs/adr`](docs/adr) and the domain vocabulary in [`CONTEXT.md`](CONTEXT.md).
