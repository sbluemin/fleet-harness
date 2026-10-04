# Claude state and trust preflight

Use this before booting a host that may launch Claude, including terminal Operations, chat, and other SDK-backed features. Fleet data isolation and Claude state isolation are separate. This is a preparation gate, not permission to edit trust, reuse credentials, or bypass approvals.

## Record the intended launch

Record the worktree/build, installed terminal CLI and bundled SDK versions, exact Theater real path, owned run directory, and the child route. Resolve directories before launch: they must be absolute, owned by this run, and not symlinks into a user's data or another session. Keep the Claude directory outside the Theater. A fresh directory has no prior trust or login; do not copy a user's home to initialize it.

| State | Location / boundary to confirm |
|---|---|
| Fleet host-shared state and legacy migration sources | Explicit `FLEET_DATA_DIR` under the owned run |
| Console settings, credentials, workspace state and lock | Explicit `FLEET_CONSOLE_DATA_DIR`; its own `console.lock` |
| Desktop owner/Electron data | Explicit `FLEET_DESKTOP_DATA_DIR`, if Desktop is used |
| Claude user settings, caches and session records | Explicit `CLAUDE_CONFIG_DIR`; ordinarily `settings.json`, `cache/`, and `projects/` beneath it |
| Claude global preferences and project trust | With `CLAUDE_CONFIG_DIR`, `<config-dir>/.claude.json`; without it, normally `~/.claude.json`. Verify this against the installed CLI before relying on it. |
| Project instructions, settings, hooks, MCP and plugins | The selected Theater and enabled settings sources, not isolated merely by changing a user directory |
| Managed policy and automatic memory | Config relocation and `settingSources` are not policy bypasses; inspect effective policy and memory paths for the selected route |
| Authentication | Environment credentials, credential files, OS credential storage and provider refresh helpers; none is made safe solely by moving the Console slot |

Do not print tokens, credential files, full configuration JSON, or a full process environment. Report only selected non-secret paths, version numbers, readiness flags and file digests.

## Select a child route, not just an environment variable

- **Terminal Claude:** Console passes the inherited Claude config directory to the CLI. A shell profile or configured executable can still change the environment. Confirm the actual executable and observe where this run's trust/cache/transcript files appear.
- **Console chat SDK:** chat selects its shared Claude home from the host's `CLAUDE_CONFIG_DIR` (otherwise `HOME/.claude`) and preserves the inherited secure-storage selection. Here “shared” means shared with that host, not necessarily the user's real home. Set the directory before booting Console, not after creating the Operation. The SDK and terminal CLI can be different versions; validate both.
- **Other SDK routes:** inspect the call site's home policy before starting it. The isolated-home SDK helper currently sets `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` deliberately to reuse default authentication. That can select the user's default Keychain service and default credential-file directory despite a separate `CLAUDE_CONFIG_DIR`. Do not launch such a route under a no-user-state-change claim until its authentication boundary is resolved. A chat result does not establish Analyst, Cowork, or every SDK feature's isolation.

On macOS, supported Claude config relocation also changes the Keychain service identity. A blank `CLAUDE_SECURESTORAGE_CONFIG_DIR` removes that separation. Treat this implementation-specific variable as a limitation to inspect, not a portable isolation API. Never set it to an empty string to repair a test login. Do not log in, log out, refresh a token, access a real Keychain credential, or copy credentials without authorization for that effect. If separation cannot be established, stop before launch and name the affected store and the decision required: an authorized credential path, a local fixture, or deferring the lane.

## Prepare the environment before the host

Use a clean allowlisted environment rather than forwarding an agent session's credentials, Console identity, or session-access tokens. Merely removing `CLAUDE_CODE_CHILD_SESSION` is insufficient. In particular, do not inherit `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, OAuth/API credentials, proxy/remote-session authentication, or `CLAUDE_SECURESTORAGE_CONFIG_DIR` accidentally. Do not dump those values to check them.

For a credential-free run, boot through the [isolated-environment wrapper](setup.md#keep-the-real-home-out). It creates the owned directories and builds this allowlisted environment (owned `HOME`, `TMPDIR`, the three Fleet paths, `CLAUDE_CONFIG_DIR`, an explicit `PATH`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`), and it refuses credential-like variables:

```bash
cd <worktree>
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir "<owned-run>" \
  -- node <worktree>/runtime/fleet-console/dist/cli.mjs serve
```

Add only required platform/runtime variables with its `--set` or `--bin`; do not copy the whole parent environment. A temporary `HOME` keeps shell startup files and fallback file writes out of the real home, but is **not** an OS sandbox or Keychain isolation. Verify executable discovery rather than borrowing a user's configuration. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` does not block required provider requests. Launching real turns still requires the credential and quota authority in the base skill.

If a scenario needs the real home, identify the files/helpers it may read or write and resolve that boundary first. Do not silently fall back because authentication or a binary cannot be found. A local protocol fixture can validate launch and storage paths without external credentials; label it as a fixture, not evidence of real provider authentication or model quality. Any fixture credentials must be newly generated for that local endpoint, never copied user tokens.

## Record the baseline before any child starts

Record digests of the relevant real-user settings/global-config files and whether this exact test Theater (and effective trust root) already has a trust entry or a `projects` directory. Do this **before the preparatory CLI**, not just before the test Operation. Select only this run's paths/identities; do not read other sessions' transcripts. Keep evidence in the scratchpad, not in the repository.

## Prepare folder trust through the normal gate

1. Before launching an agent, review the exact owned Theater, its parent instructions/settings, hooks and enabled integrations. Record the path, the CLI's effective trust root and prior trust state, and whether the task authorizes trusting this test content. Git worktrees can key trust to the main checkout root rather than the worktree path; inspect that key in the isolated config, never modify the main checkout's trust. Prefer a fresh standalone Theater for an isolation probe. Do not infer trust from Fleet registration or from another checkout with similar files.
2. Start a **preparatory interactive CLI** in that exact directory using the same isolated environment and executable as the terminal scenario. Observe onboarding/authentication and the normal folder-trust prompt before sending work. If trust requires a decision not covered by the task, stop and request that decision. If authorized, accept only the displayed owned path through the normal UI. Never write `hasTrustDialogAccepted`, preseed trust, auto-answer an unseen prompt, or use bypass flags to get past the gate.
3. Exit the preparatory CLI without sending a provider turn. Record the observed trust result and selected non-secret project-trust flag from the isolated config. Start the target terminal Operation only after preparation is complete. A CLI version that does not show the expected gate is a reason to inspect its actual policy, not to fabricate a trust entry.
4. Fleet adds its own gate, prepared after the host boots and before the first Operation prompt: Console refuses a prompt it would type into an untrusted terminal Operation (objective Commence, a terminal mention) with 409 `claude_trust_required` (`features/execution/host/agent/routes.ts`, checked by `features/workspace/host/theaters/claude-trust.ts`). The [fake Claude](setup.md#no-cost-fake-claude) shows no trust dialog, so step 2 cannot run there. When the task authorizes trusting that content, instead, with the host's `CLAUDE_CONFIG_DIR` set to the owned run, add the owned Theater through the Console folder dialog (sidebar *New Theater* or commissioning): confirm the dialog shows the trust notice and the owned path as the Theater root, then press *Add Theater*. The product then records trust for that path in the isolated `.claude.json`. Registering through the API, including `console-handoff`'s seed script, sends no consent and leaves the Theater untrusted; never send `claudeTrustConsent: true` from a script, since only the displayed add action is consent. Chat does not pass through this check.
5. Chat/SDK is not proof of interactive CLI trust: programmatic operation can have a different trust/onboarding contract. Record the operator's authority to run the SDK against the reviewed directory and confirm its home/environment before submitting the chat prompt. This is an authorization decision, not an instruction to manufacture a trust-file entry. Do not elevate `permissionMode` or enable `bypassPermissions` for verification; preserve the normal product approval path.

If startup blocks on trust/authentication, classify that separately from the behavior under test and fix the preparation once rather than repeatedly launching Operations. If an Operation or objective disappears, preserve Console state and lifecycle evidence; do not attribute disappearance to folder trust without a reproduced causal link.

## Prove the boundary and finish

After normal trust preparation, run the requested terminal and chat scenarios. Confirm the actual served build and owned PIDs, then capture this run's isolated trust entry and transcript/session locations for **each** route. A successful SDK response alone does not establish where its session was stored. `--no-session-persistence` is not isolation: startup can still create project directories and other state.

After owned children and host stop, compare the baseline and look for this run's exact Theater/session identities in the corresponding real-user locations. Unchanged digests plus isolated run records are stronger than mtimes. Concurrent unrelated writes can change a digest: report the difference and narrow attribution instead of declaring a clean home or blaming the test. Where available, an additional OS-level write-denial policy inherited by the owned host and its children can strengthen a repeat run; verify the denial without writing bytes to user files, record its exact scope, and do not represent it as portable or a replacement for supported config relocation. Do not scan, modify, delete, or restore another session's records. If a run-specific write leaked outside the owned paths, stop further launches, report the precise effect, and ask before cleanup; removing existing global traces is not part of E2E cleanup.

Report the terminal CLI/SDK versions, launch route, config/trust/session paths, trust action, credential boundary, before/after evidence, cleanup and unverified routes. Do not claim all Claude state is sandboxed from a config-directory check.

## Support and source checks

`CLAUDE_CONFIG_DIR` is documented in [Claude Code settings](https://code.claude.com/docs/en/settings); authentication storage is described in [authentication](https://code.claude.com/docs/en/authentication). Version-sensitive trust/config and secure-storage behavior must also be checked against the installed terminal CLI and bundled SDK. Fleet's current boundaries are in `features/execution/host/agent/routes.ts`, `chat-session.ts`, and `foundation/agent-runtime/src/claude/launch-env.ts` under `runtime/fleet-console/`. Recheck those call sites when changing a child route; a helper named “isolated” is not an authentication-isolation guarantee.
