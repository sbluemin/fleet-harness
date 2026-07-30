# @dotobokuri/core-unified-agent

> A TypeScript SDK that unifies Codex, Claude Code, and Cursor Agent under a single interface.

Within this monorepo, Fleet consumes `@dotobokuri/core-unified-agent` through `workspace:*` from `packages/core-unified-agent/`. It is the core engine for all Fleet agents and shares the same build and release flow as the other workspace packages.

## Overview

Unified Agent provides programmatic control of supported agent backends through a
single event-based TypeScript interface.

### Supported CLIs

| CLI | Protocol | Spawn Command |
|-----|----------|---------------|
| **Claude** | ACP | `npx --package=@agentclientprotocol/claude-agent-acp@0.33.1 claude-agent-acp` |
| **Codex** | App Server | `codex app-server --listen stdio://` |
| **Cursor Agent** | ACP | `cursor-agent acp` |

### Prerequisites

- Node.js >= 18.0.0
- At least one of the above CLIs installed and authenticated

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
    "@dotobokuri/core-unified-agent": "github:sbluemin/fleet-harness"
  }
}
```

### Quick Start

```typescript
import { UnifiedAgent } from '@dotobokuri/core-unified-agent';

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
  cli: 'claude',               // CLI selection (auto-detected if omitted)
  autoApprove: true,           // Auto-approve permissions
  yoloMode: false,             // CLI-specific YOLO approval mode
  model: 'opus',               // Model override
  clientInfo: { name: 'MyApp', version: '1.0.0' },
});
```

For Claude and Codex, `systemPrompt` is prepended once to the first user turn of a fresh session. It is not sent through provider system/developer-instruction channels, is not repeated on later turns, and is not injected when connecting to an existing session.

Codex always uses App Server. Model entries with a `-fast` suffix are virtual
catalog assets: the SDK sends their base model ID with the App Server
`priority` service tier. Reasoning effort remains a separate per-model option.

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
  +-- UnifiedCodexAgentClient
  +-- UnifiedCursorAgentClient
```

## License

MIT
