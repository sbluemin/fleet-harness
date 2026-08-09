<p align="center">
  <img src=".github/logo.png" width="420" alt="Fleet" />
</p>

<h1 align="center">One console. Every frontier coding agent.</h1>

<p align="center">
  <strong>Fleet Console runs Claude Code and Claude Gateway as live, server-owned operations</strong><br/>
  you can arrange, observe, and delegate from one local workspace.<br/>
  Native agent runtimes. Official protocols. Provider credentials never enter the agent process.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dotobokuri/fleet-console"><img src="https://img.shields.io/npm/v/@dotobokuri/fleet-console?color=c9a455" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4aab8f" alt="License"></a>
  <br/>
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

## Start in one command

Requires Node.js 20.19+ and at least one authenticated agent CLI on `PATH`.

```bash
npm install -g @dotobokuri/fleet-console

fleet console          # preferred: start the local console and open it in your browser
fleet-console          # transitional alias for the same console lifecycle
```

Prefer `fleet console`; transitional `fleet-console` still takes `status`, `restart`, and `stop`. Everything runs on your machine: the server binds to loopback by default, and the browser never receives MCP or provider tokens. Remote access stays off until you turn it on; turning it on serves the console over TLS on an interface you pick.

Prefer a native window? Install a platform build from the [latest GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest).

## Your agents keep working after you close the tab

An **Operation** is a real terminal session owned by the local Fleet Console server, not by your browser. Closing the tab detaches the socket; the PTY keeps running and its output keeps buffering. Reopen the console and the session replays its scrollback and carries on.

Idle agents are reclaimed instead of abandoned: after a threshold you choose, a quiet session goes dormant and comes back with one click. Closing an Operation or forgetting a Theater stays undoable for a few seconds, so a misclick costs nothing.

A **Theater** is a project folder. Register as many as you work in — every panel, session, and tool follows the active one.

## Three ways to work the same canvas

Operations live on an infinite canvas, and a switch in the command band decides how much of the arranging you do yourself.

| Mode | What it does | Shortcut |
|---|---|---|
| **Cruise** | Place panels wherever you want them | — |
| **Tactical** | Lay every panel out at once | <kbd>Alt</kbd>+<kbd>F</kbd> |
| **War Room** | Take waiting panels one at a time | <kbd>Alt</kbd>+<kbd>T</kbd> |

War Room is the one to reach for when several agents are waiting on you: it stages a single Operation at a time, keeps the rest in a queue, and lets you defer one with <kbd>Alt</kbd>+<kbd>→</kbd> without losing its place. <kbd>Alt</kbd>+<kbd>S</kbd> sorts the sidebar by operation status so you can see what is working, waiting, or idle at a glance.

<kbd>⌘</kbd>+<kbd>K</kbd> searches Operations across every Theater. <kbd>⌘</kbd>+<kbd>P</kbd> opens the command palette for the actions you would otherwise hunt for — resume, close, minimize, rename, regroup, recolor, switch mode.

## Keep project context beside the terminal

<img src=".github/console-repository.png" alt="Fleet Console with the Repository panel open beside two live agent operations" width="100%" />

The Activity Rail ships with eight built-in panels — **Alerts, Codex, Shell, Files, Repository, Skills, Ledger,** and **Usage limits** — and installed plugins can contribute their own. The Repository panel alone gives you history, working changes, compare, worktrees, branches, tags, and stashes for the active Theater, without leaving the operation you are supervising. Ledger and Usage limits keep token spend and provider quota in the same rail, so you notice a window filling up before a run stops. Each panel remembers its own width and can float over the canvas instead of pushing it.

## Ask questions about a session without disturbing it

<img src=".github/console-session-analyst.png" alt="Fleet Console Session Analyst producing a handoff brief artifact from a live session" width="100%" />

**Session Analyst** is read-only intelligence for a single operation. Ask it to walk through what happened, flag anything worth reviewing, or draft a handoff brief — it reads the session and answers without touching the host agent. Longer outputs are published to the **Artifacts** companion: rendered, evidence-cited documents that live in their own pane beside the session. Pick the CLI, model, and reasoning effort the analyst itself runs on — it does not have to be the model you are supervising.

## Native runtimes, coordinated — not replaced

Fleet launches the actual CLI binary in its declared product surface and speaks its supported protocol, preserving the model-native agent loop, capabilities, and authentication you already use. An Agent Operation starts as one of two kinds:

| Launch kind | What it runs |
|---|---|
| **Claude (Native)** | Plain Claude Code — Console hooks and Wiki skills are all that get added |
| **Claude (Gateway)** | Claude Code driving the models you enabled in Settings |

The gateway is a local Claude Code endpoint, not an API proxy: the Console makes the upstream request itself, and no provider credential ever enters the Claude Code process. Codex and Cursor ride the subscription you already have; Kimi and OpenCode Go take an API key you register in Settings.

| Provider | Models reachable through the gateway |
|---|---|
| **Codex** | GPT-5.6 Sol · Terra · Luna, each with a Fast variant |
| **Cursor** | Composer 2.5 · Composer 2.5 Fast · Grok 4.5 · Grok 4.5 Fast · GPT-5.6 Sol · Claude Opus 5 · Claude Fable 5 · Kimi K3 · Kimi K3 1M · Auto |
| **Moonshot-Kimi** | Kimi K3 1M, K3 256K |
| **OpenCode** | MiniMax M3 · Qwen3.8 Max · DeepSeek V4 Flash · DeepSeek V4 Pro · GLM-5.2 · Kimi K3 · MiMo V2.5 · MiMo V2.5 Pro · HY3 · Grok 4.5 · GPT-5.6 Luna |

Choose which of these the gateway offers under Settings → Plugins → Terminal → **AI Gateway**. Only models enabled there appear in Claude Code's `/model` picker and as launch defaults, and expanding a model lets you pick the reasoning levels it is offered at.

## Make it yours

Pick light or dark, then the dark tone that suits the room — **Instrument**, **Maritime**, or **Carbon**. UI and terminal typography are configurable independently, down to the installed system fonts on your machine. The console speaks English and Korean across its chrome, settings, shortcuts, and built-in plugins, and switches immediately without a reload.

Fleet Wiki keeps architecture decisions, product history, and review queues in the same workspace as execution, so the reasoning behind a change outlives the transcript that produced it.

## Fleet Console Desktop — native when you want it

Fleet Console Desktop is an optional thin native shell over Fleet Console — not a second server or a forked UI. It supervises the standard Console service, verifies the exact origin before it hands the window over — the loopback console, or a remote console whose live certificate matches the fingerprint your local Console holds for it — and loads the same `/console/` product in a sandboxed, Node-free renderer.

- Native window, tray lifecycle, and platform update flow
- Managed Node and Console runtime, replaceable independently of user state
- The same Operations, Activity Rail, companions, and settings shown above
- Coexists safely with the browser channel and never terminates an unverified Console process

Install a platform artifact from the [latest GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest). See the [Desktop guide](runtime/fleet-desktop/README.md) for artifacts, update behavior, and current limits.

> Fleet Console is a research preview.

## Go deeper

- [Fleet Development Reference](docs/fleet-development-reference.md) — extend hosts and use the SDK
- [Admiral Workflow Reference](docs/admiral-workflow-reference.md) — orchestration architecture and doctrine
- [Changelog](CHANGELOG.md) — release history

## License

MIT
