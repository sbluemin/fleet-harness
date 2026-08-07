# Admiral protocols

Prompt policy that composes the active Fleet operating mode.

## Directory index

| Directory | Responsibility |
|---|---|
| `standing-orders/` | Always-on cross-cutting prompt policy for gateway doctrine |

## Constraints

- There are two doctrines and only one renders a prompt: gateway renders a preamble, a role block, and the Standing Orders; native renders no Admiral prompt at all. Gateway renders no protocol gate, no roster, no delegation-persona instruction, and no metaphor overlay; do not reintroduce any of them.
- `standing-orders/gateway.ts` holds all six Standing Order bodies outright. Do not refactor them into shared fragments, per-order modules, or doctrine conditionals inside one body.
- Gateway doctrine names execution by surface, never by executor persona: `run` is the umbrella for one execution that returns its result, and `stage` is reserved for the workflow surface. Executor-persona, subagent, and delegation vocabulary stays out of that path — the prompt bodies and every skill asset the path renders — and `tests/prompts.test.ts` enforces the ban.
- Gateway identities are already registered in the session, so the doctrine describes a run as a call that returns. The banned thing is the asynchronous job framing — filing a job, polling it, and learning it finished from a `<system-reminder>` — not the words themselves; `ASYNC_JOB_MARKERS` in `tests/prompts.test.ts` is the enforced list, and doctrine may still say a run files no job and polls nothing.
- Execution-surface choice and model/effort assignment belong to the `workflow` skill's two gates, not to gateway Standing Orders. The Standing Orders keep only an unconditional trip-wire that loads that skill before any run leaves the host, because a gate living solely on demand cannot fire on the path that skipped loading it. Each surface's arguments, script syntax, and accepted values stay in live tool metadata.
- Gateway assignment fills judgment seats by the catalog's `capabilityClass` and spreads mechanical fans by provider allowance; spending the session's own allowance is the exception and must record which labelled exception applied. Quality signals live in the core-ai-gateway catalog, never in a fleet-admiral side table.
- The gateway path renders only into Claude Code sessions, whose harness prompt already teaches tool mechanics, deferred-tool loading, and communication defaults. Before adding an always-on sentence, check the live Claude Code system prompt for an equivalent; keeping a duplicate requires a recorded reason, because an always-on sentence spends context in every session.
- Standing Orders are always on and own their own checkpoints. Do not add a mode registry, runtime switching API, persistent selector, or HUD selector.
- Tool arguments and call mechanics belong in live tool metadata, not the static system prompt.
