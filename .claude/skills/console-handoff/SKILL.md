---
name: console-handoff
description: Prepare and seed an isolated Fleet Console URL for the user to try a change themselves. Use console-e2e for agent-driven browser verification and desktop-e2e for Electron verification.
---

# Console Handoff

Deliver a Console a person can immediately exercise: a URL already in the requested state, not an empty server. Unlike `console-e2e`, **leave the handed-over instance running**.

## Inputs

- `<worktree>`: absolute checkout path whose build is being handed over.
- `<scenario>`: initial state and interactions to try.
- `<model>`: exact gateway model id when the scenario needs a provider. Otherwise do not pin or invoke one.

Resolve values from the request and task context. Live turns spend real quota; create only the Operations necessary for the authorized scenario.

## Procedure

1. Read [Build and seeding](references/setup-and-seeding.md), then build changed dependencies before Console.
2. Boot from an absolute binary path with a fresh runtime directory in the session scratchpad. Confirm the PID command points inside `<worktree>` and read the lock's port without printing its token.
3. Create a small throwaway Theater in the scratchpad that the agent may read and edit. Never use the user's checkout or the worktree as the scenario Theater.
4. Use `scripts/seed-console.mjs` to prepare only the required state. Distinguish requested state from actual seed results; adjust the prompt/fixture when they differ. Do not report a failed setup as ready.
5. Read [Handoff format](references/handoff.md), then deliver the URL, seeded Operations/states, interactions, recreation prompt, build branch/SHA, data path, model/quota use, and PID concisely. Explain first-run dialogs and Escape behavior.

## Boundaries and completion

- Never stop/restart the user's Console or an unknown runtime.
- Do not open the testing browser for the user. Do not mix agent-browser verification with the handoff instance.
- Do not stop the instance later for cleanup. The user decides when it ends. If a requested rebuild requires restart, send the new port and URL.
- Finish once seed state, PID, and URL are verified and the handoff is delivered. Handoff is not proof that usability verification passed.
