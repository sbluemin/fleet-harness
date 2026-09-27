# Read-only client on a live Console

Read before attaching any measurement browser to a Console the user is using. The goal is a second renderer that loads the same state and streams without being able to change anything.

## Why a second client

The user's Desktop renderer exposes no remote debugging port and no DevTools menu, and restarting it destroys the evidence and the user's work. A second client on the same server reproduces the DOM, streams, and CSS of the same build. It does not reproduce state that only the user's renderer accumulated (hours of visited panels, accessibility mode enabled by an AX client), so report those as unmeasured.

## Guard script

Open the client with [`scripts/readonly-client-init.js`](../scripts/readonly-client-init.js) as an agent-browser `--init-script`, using a unique `fleet-console-e2e-*` session and `--headed false`, and set the viewport to the user's CSS size (a Computer Use capture in physical pixels divided by the display scale). The guard:

- turns every non-GET `fetch`, XHR, and beacon into a local 503 and records it in `window.__fleetE2E.blockedFetch`;
- allows only the POST reads it lists (the Objectives `state` and `objective/get` RPCs) — add another only after reading its server route and confirming it has no write side effect;
- allows the chat ticket (`channel: "chat"`), which the server refuses for dormant sessions, and rewrites every terminal ticket to `role: "viewer"`, which attaches only to live PTYs and cannot spawn, type, or resize;
- drops every `send` on terminal/agent sockets, so neither keystrokes, xterm query replies, nor resize frames reach a PTY.

The server applies the last resize from any controlling client to the PTY, and panel moves are persisted with `PATCH /api/v1/operations/:id`; both are why the guard is not optional.

## Using the client

- Dismiss first-run modals, then open panels through the sidebar focus buttons (they restore minimized panels locally). Never press a dormant panel's resume button: it spawns a CLI.
- After every reload the guard is re-applied, but CSSOM edits and injected code are gone; verify state (`rulesPresent`, focus target) before each bench.
- Check `blockedFetch` after each scenario. A retry storm there is a guard side effect, not a product finding.
- Close the session with `node .claude/skills/console-e2e/scripts/close-owned-session.mjs <session>` and confirm the user's Console and Desktop PIDs are still alive.
