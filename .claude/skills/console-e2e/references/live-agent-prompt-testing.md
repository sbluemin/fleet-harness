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
  FLEET_CONSOLE_DATA_DIR=<e2e-dir> \
  FLEET_GATEWAY_WIRE_LOG=<scratch>/wire.jsonl \
  FLEET_AI_GATEWAY_MODEL='claude-gateway--opencode--deepseek-v4-flash[1m]' \
  node /abs/path/to/worktree/runtime/fleet-console/dist/cli.mjs serve
```

- `env -u CLAUDE_CODE_CHILD_SESSION` — without it the nested Claude Code inherits the
  parent session marker and misbehaves.
- `FLEET_GATEWAY_WIRE_LOG` — the request body and the argument JSON a model actually
  produced. **It is a fallback, not an override.** The Settings wire-log toggle wins
  whenever the Console has a stored value: on writes to
  `<plugin-data-dir>/ai-gateway/wire-log.jsonl` — the *plugin* data directory, a different
  root from the settings file above — and ignores the variable, off writes nothing at all,
  and only an *unset* toggle falls through to the path you named
  (`applyWireLog` in `runtime/fleet-plugins/terminal/routes.ts`). A fresh
  `FLEET_CONSOLE_DATA_DIR` has no stored value, which is why the variable works there — until
  someone touches the toggle. The file appears on the first gateway call, not at boot.
- `FLEET_AI_GATEWAY_MODEL` — pins every request to one model whatever the client asked for
  (`packages/core-ai-gateway/src/router/router.ts`). Use the roster id verbatim,
  quoted so the shell leaves `[1m]` alone. Reach for it when you want one model forced for
  the whole run — not as a substitute for the picker, which works once a model is exposed.

## A fresh runtime directory exposes no gateway models

`/model` lists a gateway entry — labelled `From gateway` — only for models the Console was
told to expose, and that list is **isolated per runtime directory**: it lives at
`<fleet-data-dir>/ai-gateway.json`, which under `FLEET_CONSOLE_DATA_DIR=<e2e-dir>` resolves to
`<e2e-dir>/ai-gateway.json` — measured, not inferred. That promotion of the Console slot to
the Fleet root only happens while `FLEET_DATA_DIR` is unset; set the root explicitly and the
file follows the root instead, leaving the Console slot to state and locks alone. (The store also takes a `legacyDir`
pointing at the plugin data directory, but that is a one-time migration source, never where
current settings are written.) A fresh runtime directory has no such file, so the picker
shows only the Claude entries and it reads as though gateway models were unsupported. They
are not. Add one first:

Settings → **AI Gateway** (Terminal) → the provider's row in the gateway model section → choose
the model in that row's combobox → the add-model action (use its current localized label). Launch the Operation afterwards and the
entry appears, e.g. `OpenCode-DeepSeek-V4-Flash (1M Context) · From gateway`.

That combobox resists automation in four separate ways, measured 2026-08-07:

- `scrollintoview` first, or the click lands nowhere and `aria-expanded` stays `false`.
- Its options never reach the accessibility tree — `snapshot` shows none even while open.
  Select through `eval` against `[role="option"]` under the id in `aria-controls`.
- A second click toggles it shut, so opening and choosing must happen in **one** tool call.
- The button label still reads the old model if you check it in the same `eval` that
  clicked. Re-read on a later call before concluding the selection failed.

API keys are a separate store and are **not** isolated: the gateway reads the real
`~/.fleet/auth.json`, so a live turn spends the user's actual provider quota. Keep prompts
short and say so when reporting.

## Clear the dialogs before the first click

A fresh `FLEET_CONSOLE_DATA_DIR` opens the commissioning guide, then What's New, then the
three onboarding tours — each swallows clicks aimed at the page behind it, and the failure
looks like a missing element, not a blocked one. Dismiss, then assert:

```bash
ab --session fleet-console-e2e-20260807-strict eval "document.querySelectorAll('[aria-modal=\"true\"]').length"   # expect 0
```

`Escape` closes what a close button sometimes will not.

## Registering a Theater and launching the agent

Theater registration is Console's own folder UI (`/n/folder-listings`), not a native
dialog. Fill the absolute-path textbox, use its Go action, then add the Theater.
Use current localized accessible labels. The Theater's new-Operation action opens a menu whose items are
`Claude (Gateway)` and `Shell`.

Both entry points live in the sidebar, so a collapsed sidebar removes them from the
accessibility tree and the snapshot simply has no new-Theater ref — which reads as a
missing feature, not a hidden one. `Escape` can collapse it as a side effect of dismissing
something else; use the sidebar expand control (⌘B on macOS) before hunting for the ref.

Verify the launch actually attached to the gateway rather than trusting the banner — the
header still reads the Claude model name even when every request is being rerouted. Confirm
the owned PID with `ps -p <claude-pid> -o command=` and prove routing from the first
`anthropic.request` plus provider-wire event in the owned capture; the former records the
resolved model and the latter exists only after gateway dispatch.

Never print a process's full environment (`ps eww`, `/proc/<pid>/environ`, or an equivalent)
and filter it afterward. Provider keys and local credentials have already crossed into tool
output and the transcript before the filter runs, so post-processing cannot restore the
secrecy boundary.

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

Driving a browser to ask "does this backend accept X" is slow and confounded. For a standard
provider/canonical/router loop, build `core-ai-gateway` and use its `e2e:provider-loop`
runner first; it fixes the production router, credential, continuation, and cleanup contracts
without Console or PTY. Follow `ai-gateway-loop-optimization` for the exact command and
measurement contract.

Import the built adapter directly only when the runner cannot express the bespoke request
shape being tested. Requires a fresh package build — workspace `dist/` is gitignored, so a
stale or absent build silently tests the previous revision.

Run any live probe **several times**. Provider behavior here is not deterministic: measuring
tool-call arguments on this wire, roughly 1 run in 5 returned truncated JSON with no
closing brace, independent of anything the gateway does. A single clean run proves nothing.

Use the browser path when the question involves Console — launch wiring, PTY, plugin
routes, what the operator actually sees.
