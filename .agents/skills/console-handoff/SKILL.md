---
name: console-handoff
description: Boot an isolated Fleet Console from the working branch's build, seed it into the exact state a person needs to exercise a change, and hand over a URL. Use when the user says they want to try the work themselves, asks for a console to test in, or when a change is easier to judge by feel than by a report. Not for agent-run verification of the Console SPA — that is console-e2e — and not for Electron shells, which is desktop-e2e.
---

# Console handoff

Give the change to a human. The deliverable is one URL plus a short note about what is already sitting in it — a console that boots into the scenario, not an empty console the user has to build the scenario in.

This is the sibling of `console-e2e` and the two never mix. `console-e2e` drives a browser to prove something and cleans up after itself; this skill hands the keys over and then **leaves the instance running**. The moment you decide the user will be the one clicking, you are in this skill.

## Inputs

- `<worktree>` — absolute path to the checkout whose build is being handed over. Required, and always spelled out in full.
- `<scenario>` — what the user should be able to reach on the first screen (e.g. a parked question card, a failing panel, two Theaters side by side).
- `<model>` — gateway model id to pin, when the scenario reaches a provider.

## Workflow

### 1. Build the branch you are handing over

```bash
cd <worktree> && pnpm --filter @dotobokuri/fleet-console build
```

Rebuild any workspace package the change touched first (`pnpm --filter @dotobokuri/core-agent build`), because the Console bundle resolves those from `dist/`.

### 2. Boot it isolated, with the levers already set

```bash
nohup env -u CLAUDE_CODE_CHILD_SESSION \
  FLEET_CONSOLE_DATA_DIR=<handoff-dir> \
  FLEET_AI_GATEWAY_MODEL='<model>' \
  node <worktree>/runtime/fleet-console/dist/cli.mjs serve > <handoff-dir>.log 2>&1 &
```

- `<handoff-dir>` is a fresh directory outside the repo. It isolates durable state, lock, and gateway selection; credentials still come from the real `~/.fleet/auth.json`, so a live turn spends the user's actual quota.
- `nohup … &` so the instance outlives the tool call. The user is going to be using it for a while.
- `FLEET_AI_GATEWAY_MODEL` pins every request whatever the picker says — cheaper than walking the user through the AI Gateway settings before they can test.

**Then prove which binary booted.** `Bash` tool calls reset cwd between invocations, so a relative `node runtime/…/cli.mjs` silently starts the *main checkout's* Console and the log line looks identical:

```bash
ps -p "$(python3 -c "import json;print(json.load(open('<handoff-dir>/console.lock'))['pid'])")" -o command=
```

The printed path must be inside `<worktree>`. Read `port` from the same lock file; never print `token`.

### 3. Build the scenario's Theater outside the repo

Create a small folder with real files the change can act on — an agent that reads and edits inside a Theater must not be pointed at the user's actual checkout. Two or three files that make the scenario natural beat an empty directory: a model asked to choose between two designs needs something to choose about.

### 4. Seed the state

`scripts/seed-console.mjs` registers the Theater and, when given a prompt, launches a chat-born Operation and waits for the state you want:

```bash
node .agents/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir> --theater <theater> \
  --prompt "<prompt that produces the scenario>" --await ask
```

`--await ask` returns as soon as the model parks a question; `--await turn` waits for the turn to finish. Omit both to fire and forget. The JSON it prints carries `sessionId`, the URL, and the question that was parked.

To leave a *settled* example beside the live one — the two read differently and the contrast is the point — seed a second Operation and answer it:

```bash
node .agents/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir> --answer <sessionId> --pick 1
```

`--pick N` / `--text "…"` / `--approve` / `--dismiss` / `--revise "…"` cover the answer paths. The script re-reads the journal to find the parked question instead of taking its id as an argument, because a real tool_use id can contain a newline.

Seeding through the API needs no token: write routes gate on `Origin: http://127.0.0.1:<port>`, which the script sends.

### 5. Hand it over

Report in this shape — a wall of setup detail is not a handoff:

```
<url>

| Operation | State | What to look at |
|---|---|---|
| <title> | <state> | <what it demonstrates> |

## Things to try
- <one line per interaction, in the order they make sense>

## To produce a new one yourself
<the Quick Launch prompt that recreates the scenario>

## Environment
- Theater: <path> (throwaway; the agent may edit these files)
- Model: <pinned id> — spends real quota
- Data: <handoff-dir>, isolated from your usual console
- Build: <branch> (<commit>)

Stop it with PID <pid> when you are done.
```

Say which dialogs greet a fresh runtime directory (commissioning guide, What's New, then the tours) and that `Escape` clears them, or the user's first impression of the change is a modal.

## Must not

- **Do not touch the user's own Console daemon.** No `stop`, no restart, no reusing an unknown runtime directory. The handoff instance is a new directory every time.
- **Do not stop the instance you handed over**, and do not stop it later "to clean up" — the user decides when they are done. Say the PID and leave it.
- **Do not open a browser for them.** They are testing in their own browser; an agent-driven session competes for the same instance and its cleanup can kill their tab.
- **Do not point the Theater at the repo**, the worktree, or anything the user would mind an agent editing.
- **Do not report a state you did not verify.** The seed script prints what actually landed; quote that, not what you asked for.

## Gotchas

- **The port moves on every boot.** Re-read `console.lock` after any restart and re-send the URL; a stale port reads to the user as a broken build.
- **A rebuild needs a restart** for host changes and a reload for client changes. When you rebuild mid-handoff, restart and tell the user the URL changed.
- **The model may not do what the scenario needs.** A prompt that names a tool is a request, not a guarantee — verify the seeded state from the script's output and adjust the prompt rather than reporting an intent.
- **Quota is real and shared.** Keep seed prompts short, say which model is pinned, and do not seed more Operations than the scenario needs.
- **A fresh runtime directory exposes no gateway models in the picker.** Pinning through the environment sidesteps that, but if the user needs to switch models in the UI, they must add one under Settings → AI Gateway first.
