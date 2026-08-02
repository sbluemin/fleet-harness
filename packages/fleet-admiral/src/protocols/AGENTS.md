# Admiral protocols

Prompt policy that classifies work and composes the active Fleet operating mode.

## Directory index

| Directory | Responsibility |
|---|---|
| `standing-orders/` | Always-on cross-cutting prompt policy, split into `classic.ts` and `gateway.ts` |
| `../../assets/skills/protocol-*/` | On-demand operational protocol bodies (classic doctrine only) |

## Constraints

- The protocol gate, `protocol-*` skills, and the metaphor persona/tone overlays are classic-doctrine only. Gateway doctrine renders no protocol-gate block, no carrier roster, no carrier operations instruction, and no metaphor overlay; do not reintroduce any of them into the gateway path.
- Classic and gateway prompt bodies are deliberately duplicated rather than shared: one file per doctrine holds all six Standing Order bodies outright. Do not refactor them back into shared fragments, per-order modules, or doctrine conditionals inside one body.
- Gateway doctrine names execution by surface, never by executor persona: `stage`s on the workflow surface and one `Agent` run on the other. Carrier, subagent, and delegation vocabulary stays out of that path — the prompt bodies and every skill asset the path renders — and `tests/prompts.test.ts` enforces the ban.
- Naming the two execution surfaces and which one a run requires is routing and belongs in gateway doctrine; each surface's arguments, script syntax, and accepted values stay in live tool metadata.
- Gateway model and effort assignment defaults to spreading work across identities by measured fit and provider allowance; concentrating a run on the session's own model is the exception that must record its reason. `src/ai-gateway/role-fit.ts` is a dated measurement log, not a catalog — an axis it omits means unmeasured, never unsuitable.
- Operational work under classic doctrine selects exactly one protocol mode; auxiliary skills may support but never replace that mode. Conversational work does not require a mode.
- Do not add a protocol registry, runtime switching API, persistent selector, or HUD selector.
- Standing Orders are always on and consume checkpoints declared by the active protocol; they do not redefine protocol checkpoints.
- The gate is the single owner of mode selection and downward-trigger policy. Protocol bodies and Standing Orders must not duplicate those trigger lists.
- Metaphor changes persona and tone only, and only under classic doctrine; role, routing, gate, and Standing Order semantics remain neutral and unchanged.
- Tool arguments and call mechanics belong in live tool metadata, not the static system prompt.
