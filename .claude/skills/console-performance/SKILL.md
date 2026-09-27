---
name: console-performance
description: Diagnose and fix Fleet Console renderer jank — dropped frames while dragging or typing, per-keystroke lag, CPU or memory that grows until the window is reopened — with CDP measurements and a causal before/after proof, including against the user's running Console without stopping it. Use console-e2e for functional verification and design-sweep for visual consistency.
---

# Console Performance

Deliver a **measured cause**, not a plausible story: the per-event cost, what inflates it, and the same measurement after removing that cause. A green typecheck or a smaller diff is not a performance result.

## Inputs and boundaries

Record the symptom as an action plus a signal (drag, typing, streaming, idle CPU), what restores it (window reopen, mode toggle, pause), the runtime (Desktop or browser), and whether the affected Console is the user's live instance.

- Never stop, restart, reload, or send input to the user's Console or Desktop window. Observation of the live window (Computer Use screenshots/AX reads) is read-only. The user's Desktop renderer has no CDP port and no DevTools menu; do not attempt to open one.
- Measure the live instance only through a **separate read-only client** attached to the same Console server. Read [Read-only client](references/read-only-client.md) before opening it: server state writes, PTY input/resize, and dormant-session resume must be impossible from that client.
- Inspect processes with `ps -o pid,ppid,rss,%cpu,etime,comm` or `comm=` only; never print full arguments (they carry tokens).
- Code fixes follow the normal repository flow (dedicated worktree unless the user directs otherwise). The measurement client never becomes the verification of a built change unless the injected code is the committed code.

## Execution decisions

1. **Locate the layer.** A fix by reopening only the window means renderer state; a fix by server restart means host state. Sample renderer RSS/CPU over time and compare against the symptom trigger. A recovery event the user reports is evidence; re-ask when it contradicts the current hypothesis instead of fitting it.
2. **Reproduce in the read-only client** with the user's layout: the same visible panels, mode, and viewport size. Confirm the input actually lands where intended (pooled/parked bodies are `inert`; dormant panels have no composer).
3. **Measure one interaction at a time** with a control. Read [Measurement](references/measurement.md) for the per-keystroke bench, drag bench, interval metrics, traces, and attribution. Compare against an app-neutral control (an injected plain textarea) so fixed browser cost is not blamed on the app.
4. **Attribute** to a code or CSS site: hot functions mapped back to source, `UpdateLayoutTree` element counts, and invalidation-tracking selectors. A large element count per keystroke or per stream delta points to a broad style invalidation, not to the handler you edited.
5. **Prove causality** before editing: remove or replace only the suspected cause inside the read-only client (CSSOM rule deletion, injected replacement code) and rerun the identical bench. Then implement the fix at the owning layer and rerun the bench with the committed code injected or built.
6. **Check what the fix could break**: selector specificity against competing rules, every consumer of a removed pattern (`git grep` across core, features, and plugins), and the inverse path (for a modal marker: open → set, close → cleared).

## Completion

Finish when the before/after numbers for the reported interaction come from the same client, layout, and bench, the fix is the code being shipped, and cleanup is verified (owned agent-browser sessions closed through `console-e2e`'s `close-owned-session.mjs`, samplers stopped, the user's processes still running). Report measured facts, inferred links (for example, why the user's larger DOM makes the cost worse), and what could not be measured on the user's own renderer as separate categories. Do not claim the user's renderer improved until they confirm or it is measured.
