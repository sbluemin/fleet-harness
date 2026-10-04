# Handoff Console build and seeding

### 1. Build the branch you are handing over

```bash
cd <worktree> && pnpm --filter @dotobokuri/fleet-console build
```

Rebuild any workspace package the change touched first (`pnpm --filter @fleet-console/agent-runtime build`), because the Console bundle resolves those from `dist/`.

### 2. Boot it isolated, with the levers already set

Isolate the handoff exactly as an E2E run does: boot through the console-e2e [isolated-environment wrapper](../../console-e2e/references/setup.md#keep-the-real-home-out), which replaces `HOME` and every inherited Fleet and Claude path with owned directories under `<handoff-dir>`, and follow [Claude state and trust preflight](../../console-e2e/references/claude-state.md) for trust preparation whenever the scenario may start Claude (terminal or chat). The user will open the Shell surface in this instance too, so its history stays under `<handoff-dir>/home`:

```bash
nohup node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir <handoff-dir> \
  --set FLEET_AI_GATEWAY_MODEL='<model>' \
  -- node <worktree>/runtime/fleet-console/dist/cli.mjs serve > <handoff-dir>.log 2>&1 &
```

- `<handoff-dir>` is a fresh run directory placed per console-e2e's [run-directory rule](../../console-e2e/references/setup.md#isolate-the-console); the wrapper refuses one too long for its sockets. Setting only `FLEET_CONSOLE_DATA_DIR` is not enough: an inherited `FLEET_DATA_DIR` still points at the user's real Fleet root, whose legacy values are carried into the new slot once and removed from their old location.
- The Console slot owns provider credentials, so a fresh handoff starts signed out. Prefer a scenario that needs no provider, or the [no-cost fake Claude](../../console-e2e/references/setup.md#no-cost-fake-claude) (`CLAUDE_BIN`, `FAKE_CLAUDE_DIR`) when the user only needs live Operations. A live turn needs the user's explicit choice of credential path and quota; the user can sign in inside the handed-over Console. Never copy real credential files, reuse the real Fleet root, or reuse the real Claude home without that authorization, and disclose any non-isolated store before launch.
- `nohup … &` so the instance outlives the tool call. The user is going to be using it for a while. Node does not keep nohup's SIGHUP ignore, so a direct SIGHUP still stops it.
- `FLEET_AI_GATEWAY_MODEL` pins every request whatever the picker says — cheaper than walking the user through the AI Gateway settings before they can test. Omit it when no provider is used.

**Then prove which binary booted.** `Bash` tool calls reset cwd between invocations, so a relative `node runtime/…/cli.mjs` silently starts the *main checkout's* Console and the log line looks identical:

```bash
ps -p <pid> -o command=   # <pid> and <port> from the fixed lock read linked below
```

The printed path must be inside `<worktree>`. Read `pid` and `port` with the [fixed lock read](../../console-e2e/references/setup.md#read-the-lock-without-the-token).

### 3. Build the scenario's Theater outside the repo

Create a small folder with real files the change can act on — an agent that reads and edits inside a Theater must not be pointed at the user's actual checkout. Two or three files that make the scenario natural beat an empty directory: a model asked to choose between two designs needs something to choose about.

### 4. Seed the state

`scripts/seed-console.mjs` registers the Theater and, when given a prompt, launches a chat-born Operation and waits for the state you want:

```bash
node <worktree>/.claude/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir>/console --theater <theater> \
  --prompt "<prompt that produces the scenario>" --await ask
```

`--await ask` returns as soon as the model parks a question; `--await turn` waits for the turn to finish. Omit both to fire and forget. The JSON it prints carries `sessionId`, the URL, and the question that was parked.

To leave a *settled* example beside the live one — the two read differently and the contrast is the point — seed a second Operation and answer it:

```bash
node <worktree>/.claude/skills/console-handoff/scripts/seed-console.mjs --dir <handoff-dir>/console --answer <sessionId> --pick 1
```

`--pick N` / `--text "…"` / `--approve` / `--dismiss` / `--revise "…"` cover the answer paths. The script re-reads the journal to find the parked question instead of taking its id as an argument, because a real tool_use id can contain a newline.

Seeding through the API needs no token: write routes gate on `Origin: http://127.0.0.1:<port>`, which the script sends.
