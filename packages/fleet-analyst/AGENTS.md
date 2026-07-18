# fleet-analyst

Owns ephemeral Session Analyst indexing, bounded MCP tools, and UnifiedAgent session lifecycle.

- State, artifacts, conversations, secrets, and tool snapshots are process-memory only. Do not write captures, caches, artifacts, or browser storage.
- Existing transcript/capture files are read-only inputs. Never expose their paths, provider session identifiers, raw contents, MCP URLs, or bearer values.
- This package may depend only on `core-agent` and `core-unified-agent`; runtime hosts and `fleet-admiral` remain consumers, never dependencies.
- The root export is the sole public API. Keep internal implementation imports private.
