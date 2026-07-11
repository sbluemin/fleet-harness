# Admiral protocols

Prompt policy that classifies work and composes the active Fleet operating mode.

## Directory index

| Directory | Responsibility |
|---|---|
| `standing-orders/` | Always-on cross-cutting prompt policy |
| `../../assets/skills/protocol-*/` | On-demand operational protocol bodies |

## Constraints

- Operational work selects exactly one protocol mode; auxiliary skills may support but never replace that mode. Conversational work does not require a mode.
- Do not add a protocol registry, runtime switching API, persistent selector, or HUD selector.
- Standing Orders are always on and consume checkpoints declared by the active protocol; they do not redefine protocol checkpoints.
- The gate is the single owner of mode selection and downward-trigger policy. Protocol bodies and Standing Orders must not duplicate those trigger lists.
- Metaphor changes persona and tone only; role, routing, gate, and Standing Order semantics remain neutral and unchanged.
- Tool arguments and call mechanics belong in live tool metadata, not the static system prompt.
