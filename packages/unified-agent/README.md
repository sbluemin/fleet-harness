# @sbluemin/fleet-unified-agent

> A TypeScript SDK that unifies Codex CLI, Claude Code, and Gemini CLI under a single interface.

Within this monorepo, Fleet consumes `@sbluemin/fleet-unified-agent` through `workspace:*` from `packages/unified-agent/`. It is the core engine for all Fleet agents and shares the same build and release flow as the other workspace packages.

## Overview

Unified Agent provides two ways to control three major CLI agents — Gemini, Claude, and Codex — under a single interface.

- **CLI Binary** — One-shot prompt execution from the command line
- **TypeScript SDK** — Full programmatic control with event-based streaming

### Supported CLIs

| CLI | Protocol | Spawn Command |
|-----|----------|---------------|
| **Gemini** | ACP | `gemini --acp` |
| **Claude** | ACP | `npx --package=@agentclientprotocol/claude-agent-acp@0.33.1 claude-agent-acp` |
| **Codex** | `codex-app-server` | `codex app-server --listen stdio://` |

### Prerequisites

- Node.js >= 18.0.0
- At least one of the above CLIs installed and authenticated

---

## CLI Usage

### Installation

Clone the repository and link globally:

```bash
git clone https://github.com/sbluemin/fleet-harness.git
cd fleet-harness/packages/unified-agent
pnpm install
pnpm build
pnpm link --global
```

After linking, the `ait` command is available globally:

```bash
ait --help
```

To unlink:

```bash
npm unlink -g @sbluemin/fleet-unified-agent
```

### REPL Mode

Running `ait` without any arguments enters the interactive REPL mode:

```bash
ait
```

#### REPL Prompt
The prompt displays the current model, and shows reasoning effort only for CLIs that support it:
`ait (model) (effort) ❯`

#### Slash Commands
| Command | Description |
|---------|-------------|
| `/model <name>` | Change the current model |
| `/effort <level>` | Change reasoning effort when supported; Gemini still ignores it with a notice |
| `/status` | Show connection status and session info |
| `/clear` | Clear the terminal screen |
| `/help` | Show available commands |
| `/exit` | Exit the REPL |

#### Keyboard Shortcuts
- **Ctrl+C**:
  - While streaming: Cancels the current response generation.
  - While waiting for input: Double-tap to exit the REPL.

### Basic Usage (One-shot)

```bash
# Auto-detect available CLI and run
ait "Analyze this project"

# Select a specific CLI
ait -c claude "Review this code"

# Select a model
ait -c claude -m opus "Find bugs"

# Set reasoning effort (Codex)
ait -c codex -e high "Refactor this module"

# Claude Sonnet supports `low | medium | high | max`
ait -c claude -m sonnet -e max "Review this code"

# Pipe from stdin
cat error.log | ait -c gemini "Explain this error"

# Resume a previous session
ait -c claude -s <sessionId> "Continue this conversation"

# JSON output (for scripting / AI agents)
ait --json -c claude "Summarize" | jq .response
```

### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--cli <name>` | `-c` | CLI selection (`gemini` \| `claude` \| `codex`) |
| `--session <id>` | `-s` | Resume a previous session (requires `--cli`) |
| `--model <name>` | `-m` | Model override |
| `--effort <level>` | `-e` | Reasoning effort when supported by the selected CLI |
| `--cwd <path>` | `-d` | Working directory (default: current directory) |
| `--yolo` | | Auto-approve all permissions (mapped to `--approval-mode=yolo` for Gemini internally) |
| `--json` | | JSON output mode |
| `--help` | `-h` | Show help |

### Output Modes

**Pretty mode** (default) — streams the AI response to stdout with status on stderr:

```
● ait (claude)

The project is a TypeScript SDK that...

  ▶ Read file: src/index.ts
  ▶ Read file: package.json

● Done (12.3s)
```

**JSON mode** (`--json`) — outputs a single JSON object to stdout:

```json
{"response":"The project is a TypeScript SDK that...","cli":"claude"}
```

On error:

```json
{"error":"No available CLI found"}
```

### Reasoning Effort Support

- **Codex**: supported via native `codex-app-server` turn config
- **Claude (ACP via `claude-agent-acp`)**: supported on the `claude` provider with `low | medium | high | max`
- **Gemini**: unsupported, `ait -c gemini -e high ...` is ignored with a notice

Fleet sends Claude ACP effort through the bridge's advertised `effort` config option. Only the primary `claude` provider exposes effort in `models.json`; `claude-zai` and `claude-kimi` remain conservatively disabled in this package.

---

## SDK Usage

### Installation

Add as a dependency via git URL:

```bash
npm install github:sbluemin/fleet-harness
```

In `package.json`:

```json
{
  "dependencies": {
    "@sbluemin/fleet-unified-agent": "github:sbluemin/fleet-harness"
  }
}
```

### Quick Start

```typescript
import { UnifiedAgent } from '@sbluemin/fleet-unified-agent';

const client = await UnifiedAgent.build();

// Set up event listeners
client.on('messageChunk', (text) => process.stdout.write(text));
client.on('toolCall', (title, status) => console.log(`Tool: ${title} (${status})`));

// Connect (auto-detects available CLI)
await client.connect({
  cwd: '/my/workspace',
  autoApprove: true,
});

// Send a message
await client.sendMessage('Analyze this project');

// Disconnect
await client.disconnect();
```

### API

#### `connect(options: UnifiedClientOptions): Promise<ConnectResult>`

Connects to a CLI agent.

```typescript
const result = await client.connect({
  cwd: '/my/workspace',       // Working directory (required)
  cli: 'gemini',               // CLI selection (auto-detected if omitted)
  autoApprove: true,           // Auto-approve permissions
  yoloMode: false,             // CLI-specific YOLO approval mode
  model: 'gemini-pro',         // Model override
  clientInfo: { name: 'MyApp', version: '1.0.0' },
});
```

For Codex, `systemPrompt` is passed to the native app-server as `developerInstructions` during thread creation rather than being prefixed onto the first user turn.

#### `sendMessage(content: string | AcpContentBlock[]): Promise<PromptResponse>`

Sends a message to the agent.

#### `cancelPrompt(): Promise<void>`

Cancels the currently running prompt.

#### `setModel(model: string): Promise<void>`

Changes the model.

#### `setConfigOption(configId: string, value: string): Promise<void>`

Updates a session configuration option (e.g. `effort`).

#### `setMode(mode: string): Promise<void>`

Sets the agent mode (e.g. `plan`, `yolo`, `bypassPermissions`).

#### `loadSession(sessionId: string): Promise<void>`

Reloads an existing session.

#### `detectClis(): Promise<CliDetectionResult[]>`

Detects available CLIs on the system.

#### `getAvailableModels(): AvailableModelsResult | null`

Returns the list of available models for the connected CLI.

#### `disconnect(): Promise<void>`

Closes the connection and terminates the child process.

### Events

| Event | Parameters | Description |
|-------|------------|-------------|
| `messageChunk` | `(text, sessionId)` | AI response text streaming |
| `thoughtChunk` | `(text, sessionId)` | AI thinking process |
| `toolCall` | `(title, status, sessionId)` | Tool invocation |
| `plan` | `(plan, sessionId)` | Plan update |
| `userMessageChunk` | `(text, sessionId)` | User message replay streaming |
| `permissionRequest` | `(params, resolve)` | Permission request callback |
| `promptComplete` | `(sessionId)` | Prompt completion |
| `stateChange` | `(state)` | Connection state change |
| `error` | `(error)` | Error |

### Submodules

| Module | Description |
|--------|-------------|
| `AcpConnection` | Direct ACP protocol access |
| `CliDetector` | CLI auto-detection |
| `cleanEnvironment` | Environment variable sanitization |
| `killProcess` | Safe process termination |

---

## Architecture

```
UnifiedAgent
  +-- UnifiedClaudeAgentClient
  +-- UnifiedGeminiAgentClient
  +-- UnifiedCodexAgentClient
```

## License

MIT
