# Handoff Console build and seeding

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

- `<handoff-dir>` is a fresh directory under the session scratchpad outside the repo. It isolates durable state, lock, and gateway selection; credentials still come from the real `~/.fleet/auth.json`, so a live turn spends the user's actual quota.
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
node <worktree>/.claude/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir> --theater <theater> \
  --prompt "<prompt that produces the scenario>" --await ask
```

`--await ask` returns as soon as the model parks a question; `--await turn` waits for the turn to finish. Omit both to fire and forget. The JSON it prints carries `sessionId`, the URL, and the question that was parked.

To leave a *settled* example beside the live one — the two read differently and the contrast is the point — seed a second Operation and answer it:

```bash
node <worktree>/.claude/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir> --answer <sessionId> --pick 1
```

`--pick N` / `--text "…"` / `--approve` / `--dismiss` / `--revise "…"` cover the answer paths. The script re-reads the journal to find the parked question instead of taking its id as an argument, because a real tool_use id can contain a newline.

Seeding through the API needs no token: write routes gate on `Origin: http://127.0.0.1:<port>`, which the script sends.
