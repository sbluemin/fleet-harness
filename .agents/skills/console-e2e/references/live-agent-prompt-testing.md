# Driving a real agent Operation and capturing its provider traffic

Read this when the scenario needs a **live agent CLI turn** — an Operation that actually
boots Claude Code, sends a prompt, and reaches a provider — rather than Console SPA
behavior alone. Typical reasons: verifying an AI Gateway adapter against a real backend,
reproducing a provider-specific tool-call defect, or measuring what a model actually put
on the wire.

The base skill still owns isolation, instrumentation, and cleanup. This page only adds
what the agent-CLI path needs on top, and every item below was paid for by a failed
attempt.

## Absolute paths, or you test the wrong build

`Bash` tool calls reset cwd between invocations. `node runtime/fleet-console/dist/cli.mjs
serve` therefore starts the **main checkout's** Console, not your worktree's — the two are
indistinguishable in the log line, and the mistake only surfaces after you "verify" a fix
that never ran. Always spell the binary out:

```bash
node /abs/path/to/worktree/runtime/fleet-console/dist/cli.mjs serve
```

Confirm what actually booted before trusting any result:

```bash
ps -p "$(python3 -c "import json;print(json.load(open('<e2e-dir>/console.lock'))['pid'])")" -o command=
```

Every `<placeholder>` below is spelled out on each call, never carried in a shell variable —
cwd and shell state reset between tool calls, so a variable set in one call is empty in the
next. That includes the browser session id: the base skill requires the same **literal** id in
every independent `ab` call. The examples use `fleet-console-e2e-20260807-strict`; replace it
consistently, and replace `<e2e-dir>` / `<scratch>` / `<worktree>` / `<port>` the same way.

## Serve with the capture and model levers already set

Both env vars are read by the **Console server process**, because the AI Gateway runs
in-process there (`runtime/fleet-plugins/terminal/server/ai-gateway-routes.ts`), not in a
sidecar. Setting them on the spawned agent CLI is too late.

```bash
env -u CLAUDE_CODE_CHILD_SESSION \
  FLEET_CONSOLE_DIR=<e2e-dir> \
  FLEET_GATEWAY_WIRE_LOG=<scratch>/wire.jsonl \
  FLEET_AI_GATEWAY_MODEL='claude-gateway--opencode--deepseek-v4-flash[1m]' \
  node /abs/path/to/worktree/runtime/fleet-console/dist/cli.mjs serve
```

- `env -u CLAUDE_CODE_CHILD_SESSION` — without it the nested Claude Code inherits the
  parent session marker and misbehaves.
- `FLEET_GATEWAY_WIRE_LOG` — the only way to see the request body and the argument JSON a
  model actually produced. The file appears on the first gateway call, not at boot.
- `FLEET_AI_GATEWAY_MODEL` — **the reliable way to pin a gateway model.** It overrides
  `body.model` for every request (`packages/core-ai-gateway/src/gateway-router/router.ts`).
  Use the roster id verbatim, quoted so the shell leaves `[1m]` alone.

**`/model` inside Claude Code does not list gateway models.** Measured 2026-08-07 on
v2.1.224 with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` set and the gateway attached:
the picker showed only the five Claude entries. Do not burn turns hunting for a gateway
entry in that list — pin the model at the server instead.

Credentials are **not** isolated by `FLEET_CONSOLE_DIR`: the gateway reads the real
`~/.fleet/auth.json` and `~/.fleet/ai-gateway.json`, so a live turn spends the user's
actual provider quota. Keep prompts short and say so when reporting.

## Clear the dialogs before the first click

A fresh `FLEET_CONSOLE_DIR` opens the commissioning guide, then What's New, then the
three onboarding tours — each swallows clicks aimed at the page behind it, and the failure
looks like a missing element, not a blocked one. Dismiss, then assert:

```bash
ab --session fleet-console-e2e-20260807-strict eval "document.querySelectorAll('[aria-modal=\"true\"]').length"   # expect 0
```

`Escape` closes what a close button sometimes will not.

## Registering a Theater and launching the agent

Theater registration is Console's own folder UI (`/n/folder-listings`), not a native
dialog. Fill the **절대 경로로 이동 / absolute path** textbox, press 이동/Go, then
Theater 추가. After that, `<theater>에서 새 Operation` opens a menu whose items are
`Claude (Native)`, `Claude (Classic)`, `Claude (Gateway)`, `Shell`.

Verify the launch actually attached to the gateway rather than trusting the banner — the
header still reads the Claude model name even when every request is being rerouted:

```bash
ps eww -p <claude-pid> | tr ' ' '\n' | grep -E '^(ANTHROPIC_BASE_URL|FLEET_GATEWAY_WIRE_LOG)'
# ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/plugins/terminal/ai-gateway
```

## Typing into the terminal

`ab type` and `ab fill` **do not reach xterm**. Only `press` does, one key at a time:

```bash
for k in "/" m o d e l; do ab --session fleet-console-e2e-20260807-strict press "$k" >/dev/null; done
ab --session fleet-console-e2e-20260807-strict press Enter
```

The terminal renders to **canvas**, so `.xterm-rows` is empty and there is no DOM text to
read. Screenshot to observe state. Click the `region "Terminal"` ref first; refs go stale
after every rerender, so re-snapshot rather than reusing one across steps.

## Reading the capture

`wire.jsonl` is append-only JSONL, one event per line:

| `event` | What it carries |
|---|---|
| `anthropic.request` | the client's `model` and the `resolvedModel` after any override — the fastest proof a pin took effect |
| `canonical.request` | the provider-neutral request |
| `<provider>.wire.request` | the literal upstream URL and body, including the full `tools` array |
| `canonical.event` | every translated response event |

Boot alone emits a quota probe (`messages: [{role:"user",content:"quota"}]`, `max_tokens:
1`) that carries **no tools**. A real prompt is required before the tool catalog appears.

```bash
python3 -c "
import json
rows=[json.loads(l) for l in open('<scratch>/wire.jsonl')]
req=[r for r in rows if r['event'].endswith('.wire.request')][-1]['payload']['payload']
print(len(req.get('tools',[])), 'tools')
print(json.dumps(req['tools'][0], indent=2)[:800])
"
```

## Skip the UI when the question is about the provider

Driving a browser to ask "does this backend accept X" is slow and confounded. Import the
built adapter and call it directly — same code path, no Console, no PTY:

```js
const { OpencodeGoChatCompletionsAdapter } = await import('<worktree>/packages/core-ai-gateway/dist/index.js');
const key = JSON.parse(fs.readFileSync('/Users/<you>/.fleet/auth.json','utf8'))['Claude Code with OpenCode Go'].key;
const res = await new OpencodeGoChatCompletionsAdapter({}).stream(
  { model: 'deepseek-v4-flash', input: [...], stream: true, tools: [...] },
  { apiKey: key },
);
for await (const ev of res.events) { /* inspect canonical events */ }
```

Requires `pnpm run build` in the package first — workspace `dist/` is gitignored, so a
stale or absent build silently tests the previous revision.

Run any probe **several times**. Provider behavior here is not deterministic: measuring
tool-call arguments on this wire, roughly 1 run in 5 returned truncated JSON with no
closing brace, independent of anything the gateway does. A single clean run proves nothing.

Use the browser path when the question involves Console — launch wiring, PTY, plugin
routes, what the operator actually sees. Use the direct-adapter path when the question is
purely "what does this provider do".
