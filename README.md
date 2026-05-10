<div align="center">
    <h1>Fleet Harness</h1>
    <img src=".github/logo.png" alt="fleet-harness" width="640" />
    <h3><em>One Fleet. All LLMs.</em></h3>
</div>

<p align="center">
    <strong>A multi-LLM orchestration kit that operates Claude Code, Codex CLI, and Gemini CLI through a single unified interface — using native CLIs directly, no API wrapping or proxying.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

---

<div align="center">
  <img src=".github/fleet-harness.gif" alt="fleet-harness demo" width="640" />
</div>

## Motivation

Every frontier CLI — Claude Code, Codex, Gemini, OpenCode — ships with an agent loop tuned specifically for its underlying model. Claude's loop is built for deep reasoning and tool orchestration. Codex optimizes for rapid code generation and iterative execution. Gemini leverages enormous context windows for research and synthesis. OpenCode unifies multiple models under one adaptive loop. These are not thin API wrappers; they are full-fledged, model-native agent runtimes refined by their creators.

The problem is that they all live in separate terminals. To combine their strengths on a single task, you must copy context between windows, manually sync state, and context-switch across different interaction patterns. The friction of multi-tool coordination often forces you to settle for a single CLI, leaving the unique capabilities of the others on the table.

Fleet Harness was built to remove that friction without sacrificing what makes each CLI special. It treats every native agent runtime as a **Carrier** within a naval **Fleet**. A central Admiral orchestrates multiple Carriers in parallel through their official protocols, so each model's native loop runs exactly as designed — just coordinated under one command. You give the order once; the fleet executes together, with every Carrier contributing its distinct strengths.

## Naval Fleet Hierarchy

A 4-tier command structure maps users, orchestrators, and agents into clear roles:

- **Admiral of the Navy** — The user. Sets strategy and gives orders.
- **Fleet Admiral** — Multi-fleet orchestrator (Admiralty persona internalized in `fleet-core`).
- **Admiral** — A workspace PI instance. Plans and dispatches Carriers.
- **Captain** — The commander persona of a Carrier agent.

A **Carrier** is an execution instance of a CLI tool with isolated configuration. A **Captain** is the persona (e.g., Chief Engineer, Scout Specialist) that commands it.

## Carriers

> Per-carrier configuration (model selection, reasoning level, etc.) can be adjusted from the Fleet Bridge UI (`Alt+O`).

Eight built-in Carriers, each with a distinct operational role:

- **Nimitz** — Strategic Command & Judgment. Read-only architecture decisions and trade-off adjudication.
- **Kirov** — Operational Planning Bridge. Clarifies requirements and authors plan_file under .fleet/plans/*.md for Ohio.
- **Genesis** — Chief Engineer. Single-shot implementation under Admiral direction.
- **Ohio** — Multi-Wave Strike Execution. Consumes Kirov-authored plan_file and executes wave-by-wave to completion.
- **Sentinel** — QA & Security Lead. Code review, defect detection, and vulnerability hunting.
- **Vanguard** — Scout Specialist. Codebase exploration, symbol tracing, and web research.
- **Tempest** — Forward External Intelligence Strike. GitHub intelligence and external repo analysis.
- **Chronicle** — Chief Knowledge Officer. Documentation, changelogs, and change-impact reporting.

## Features

### Multi-LLM Orchestration

Fleet Harness does not wrap APIs or run proxies — it orchestrates **native frontier CLI tools directly**. Each carrier spawns the actual CLI binary and communicates through its official protocol (ACP or App Server), giving you the full native capabilities of each tool within a unified command structure.

<img src=".github/handoff.png" alt="Multi-LLM Orchestration" width="100%" />

| CLI | Provider | Protocol | Key Capabilities |
|-----|----------|----------|------------------|
| **Claude Code** | Anthropic | ACP | Deep reasoning, architecture judgment |
| **Claude Code (Z.AI GLM)** | Z.AI | ACP | GLM-5 series via Claude bridge |
| **Claude Code (Moonshot Kimi)** | Moonshot | ACP | Kimi K2 series via Claude bridge |
| **Codex CLI** | OpenAI | App Server | Fast code generation, multi-wave execution |
| **Gemini CLI** | Google | ACP | Large-context analysis, research |
| **OpenCode Go** | OpenCode | ACP | DeepSeek, GLM, Kimi, MiMo, MiniMax, Qwen |

Every carrier runs in parallel under a single command structure, with unified progress tracking so you always know the status of the entire fleet. Fine-tune each carrier independently — select models, set reasoning levels, and adjust parameters without leaving the fleet interface. Fleet Action provides the autonomous operating framework for routing, delegation, review, and documentation.

### Fleet Bridge

<img src=".github/hud.png" alt="Fleet Bridge HUD" width="100%" />

Fleet Bridge is your mission control center. The integrated heads-up display puts everything you need in one view — a full-featured editor, a real-time status bar, and a contextual footer that tracks session state, token usage, and cost. Metaphor-based directive refinement breaks complex requests into clear operational sections, while automatic session summaries and a built-in thinking timer keep your workflow transparent and measurable.

Watch every active carrier stream results in real time, navigate between carrier slots inline, and toggle a detailed focus view when you need to drill down into a specific agent's output. All from a single, unified interface.

### Carrier

<img src=".github/carrier_status.png" alt="Carrier Status" width="100%" />

The Carrier layer is the fleet's execution engine. Whether you need a single agent, a coordinated squadron, or a cross-model task force, you deploy and control every operation through a unified dispatch interface.

#### Sortie

Deploy one carrier or an entire wing with a single command. Sortie supports fire-and-forget delegation, parallel multi-carrier dispatch in one call, and asynchronous result delivery through push notifications or on-demand lookup via `carrier_jobs`. Set your objectives, launch the fleet, and collect results as they arrive.

#### Squadron

When a task breaks into independent pieces, Squadron fans them out across parallel instances of the same carrier. Perfect for batch analysis, per-file processing, or divide-and-conquer workloads — with up to 10 concurrent subtasks dispatched and tracked as a single coordinated operation.

#### Task Force

Task Force runs the same mission across multiple CLI backends at once, then surfaces a cross-model consensus. Use it to validate critical decisions, compare how different models approach the same problem, and eliminate single-model blind spots before committing to a course of action.

## Commands

After `pnpm link --global` (see [SETUP.md](SETUP.md)), five global commands are available:

| Command | Description |
|---------|-------------|
| `fleet` | Launch standard Fleet mode |
| `fleet-wiki` | Launch the Fleet Wiki web UI for the current workspace |

## Setup

See [SETUP.md](SETUP.md) for step-by-step instructions.

Provider contract note:
- `@sbluemin/fleet-ai` now provides abstractions and registration seams only; built-in vendor providers and built-in OAuth providers are removed.
- `packages/fleet-harness-extension/src/provider.ts` is the host-owned registration gateway.
- The old registry-filter workaround is removed; any pre-registration provider-missing throw is intentional until follow-up host wiring lands.

> **Quick Start with AI Agent** — Copy and paste into your LLM agent:
>
> Install and configure fleet-harness by following the instructions here: `https://raw.githubusercontent.com/sbluemin/fleet-harness/main/SETUP.md`

## Documentation

- [Fleet Development Reference](./docs/fleet-development-reference.md) — The comprehensive guide for developing Fleet host extensions and using the SDK.
- [Admiral Workflow Reference](./docs/admiral-workflow-reference.md) — Deep dive into the naval fleet architecture and operational doctrine.
- [CHANGELOG](./CHANGELOG.md) — Project history and release notes.

## License

MIT
