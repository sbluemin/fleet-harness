---
name: console-handoff
description: Prepare and seed an isolated Fleet Console and open it in this Operation's Fleet Browser so the user can try a change themselves. Use console-e2e for agent-driven browser or Electron Desktop verification.
---

# Console Handoff

Deliver a Console a person can immediately exercise: this Operation's Fleet Browser already showing the requested state, not an empty server. Unlike `console-e2e`, **leave the handed-over instance and its Fleet Browser tab running**.

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
5. Read [Handoff format](references/handoff.md), open the seeded URL in this Operation's Fleet Browser, leave that tab, then deliver the URL, seeded Operations/states, interactions, recreation prompt, build branch/SHA, data path, model/quota use, and PID concisely. Explain first-run dialogs and Escape behavior.

## Boundaries and completion

- Never stop/restart the user's Console or an unknown runtime.
- Open the seeded URL in this Operation's Fleet Browser. Do not drive that instance as `console-e2e` or open it with agent-browser. Use the OS opener only when Fleet Browser is unavailable.
- Do not stop the instance later for cleanup. Do not close the handoff tab or the user's other tabs. The user decides when it ends. If a requested rebuild requires restart, re-read the lock, open the new URL in Fleet Browser, and send it.
- Finish once seed state, PID, URL, and the Fleet Browser open (or the documented fallback) are verified and the handoff is delivered. Handoff is not proof that usability verification passed.
