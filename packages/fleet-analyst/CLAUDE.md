# fleet-analyst

Owns ephemeral Session Analyst indexing, bounded MCP tools, and gateway-SDK session lifecycle.

- State, artifacts, conversations, secrets, and tool snapshots are process-memory only. Do not write captures, caches, artifacts, or browser storage.
- Existing transcript/capture files are read-only inputs. Never expose their paths, provider session identifiers, raw contents, MCP URLs, or bearer values.
- This package may depend only on `core-agent`; runtime hosts and `fleet-admiral` remain consumers, never dependencies. The analyst reaches its model through the host's AI Gateway, so it takes a `baseUrl` and never resolves, detects, or launches an Agent CLI.
- The root export is the sole public API. Keep internal implementation imports private.
