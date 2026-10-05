# Console Process Lifecycle Contract

One Console `serve` process has one lifecycle, and every actor that deals with it — the serve process itself, CLI `start`/`stop`/`restart`, the Fleet Desktop sidecar supervisor, the Console update worker and its recovery, and the local Console list — follows this contract instead of its own judgment. This page is the contract and its rationale. The code lives in two places:

- `@fleet-console/protocol/lifecycle` (`runtime/fleet-console/protocol/lifecycle/`): the pure contract — states, time budgets, the instance classifier (`classifyConsoleInstance`), the exit record schema, and lock-slot classification.
- `@fleet-console/lifecycle` (`runtime/fleet-console/foundation/lifecycle/`): observation and IO — pid liveness and process start times, the token-authenticated health probe, instance observation (`observeConsoleInstance`), the stop ladder (`runStopLadder`), exit records, the owned-process registry, and Console-owned temporary namespaces.

The serve state owner is `runtime/fleet-console/core/host/bootstrap/serve-lifecycle.ts`. Lock publication and the reclaim of another instance's lock are a separate, referenced contract: [Console Lock Reclaim Across Hosts](console-lock-reclaim.md).

Actors are being moved onto the contract in stages. A section marked *(pending)* names behavior an actor still implements on its own until its stage lands; the contract text is the target.

## Invariants

| # | Invariant |
|---|---|
| I1 | No actor signals a process whose identity it has not proven, and no actor removes a lock it did not prove released or dead. |
| I2 | However a Console ends — clean stop, its own deadline, a crash, an external SIGKILL — it leaves no child process behind. |
| I3 | A serve that loses the lock writes nothing: no product state, no exit record. |
| I4 | An external escalation to SIGKILL comes only after the Console's own deadline has had its chance. |
| I5 | After a crash or an external SIGKILL, the next Console reclaims the lock. |

## States

| State | Lock | Requests | Leaves when |
|---|---|---|---|
| binding | none | listener bound; nothing is served | the lock is published (→ starting), or lost (exit `CONSOLE_SERVE_EXIT_LOCK_HELD` = 73, nothing written) |
| starting | held | authenticated health answers `503 {"error":"console_starting","pid"}`; everything else `503 {"error":"console_starting"}` | activation finishes (→ ready) or a stop is requested |
| ready | held | served | a stop is requested |
| stopping | held | listeners close first; nothing new is admitted | the single cleanup ends and releases the lock (→ releasing) |
| releasing | released | none | the last handle closes (→ exited) or the deadline fires |
| exited | left behind only after a crash, a deadline, or an external kill | — | — |

One serve process runs one instance: its server starts at most once, and a server whose start failed or that has stopped is never started again — a new instance is a new `serve`.

### One stop request, one shutdown

- Every way a Console is asked to stop is the same request: SIGTERM or SIGINT, an accepted in-place update stopping itself, and a programmatic `server.stop()`. The first request moves the instance to *stopping*, arms the deadline, and starts the single cleanup; every later request receives that same cleanup and never starts another. A request during startup waits for startup to settle before the cleanup runs, so a writer that is still restoring state never loses its lock under it. Such an instance stays *stopping* and never becomes *ready*, even when activation then completes; it does not admit requests on its way down.
- The lock is released once, at the very end of that cleanup. No request — the first or any later one — settles before then, so no caller sees a Console as stopped while it still holds the lock and runs cleanup. (Before this contract an update's self-stop did not arm the deadline, and a SIGTERM arriving during it returned before the cleanup and the lock release: follow-up 3b17763a.) A cleanup that fails part-way leaves the instance *stopping* — it may still hold the lock — until the process ends (outcome `failed`); the next `serve` reclaims a lock left that way once the pid is ESRCH, and outside actors see a held lock and follow the stop ladder.
- The signal handlers are installed before the lock is published and stay until the process exits, including *releasing*, where the SDK may still be reaping a child that ignored SIGTERM. Later signals are accepted and ignored.
- An uncaught exception while *ready* exits at once with status 1 (outcome `crash`); children are left to the containment described under [Children](#children). During *stopping* or *releasing* it only sets the exit status to 1 (still outcome `crash`) and lets the cleanup or the deadline finish.

## Time budgets

All waits derive from the constants in `@fleet-console/protocol/lifecycle`. No actor restates a value.

| Name | Value | Meaning |
|---|---|---|
| `CONSOLE_STOP_DEADLINE_MS` (B_int) | 10 s | From the first stop request until the serve process exits. When it fires, the Console SIGKILLs its leftover children, records `deadline`, and exits 1. The same timer bounds a stop requested during startup. |
| `PROCESS_TABLE_TIMEOUT_MS` | 1 s | The longest a `ps` read may take; past it the reader signals nobody. |
| `ESCALATION_MARGIN_MS` | 1 s | Covers a busy event loop delaying the stop handler at signal time and the deadline timer at expiry. |
| `EXTERNAL_ESCALATION_MS` (B_ext) | B_int + 1 s + 1 s = 12 s | How long an actor that sent SIGTERM waits before it may SIGKILL. Defined only as that sum. |
| `KILL_CONFIRM_MS` | 3 s | How long an actor that sent SIGKILL waits to see the pid exit. |

Why B_ext is derived: an external SIGKILL that lands at the same moment as the Console's own deadline races the Console's cleanup of its children. Polling phase only ever delays an external escalation, so the margin needed is the Console's own worst-case delay: its process-table read plus event-loop lag. With B_ext = B_int + that delay, a Console within its own budget always finishes first (I4). A Console whose loop is blocked for more than a second at signal time can still lose that race; containment must then still leave no children (I2).

## Exit record

A Console instance that held the lock writes its own exit record beside its lock as its process exits, named by its instance key: `console.exit.<pid>-<lockStartedAt>.json` (`consoleExitRecordPath(lockFile, instance)`).

```json
{ "v": 1, "pid": 4242, "lockStartedAt": 1791163806746, "outcome": "deadline", "killed": 2, "at": 1791163817000 }
```

- `pid` and `lockStartedAt` (the `startedAt` of the lock that instance published) are the instance key. A reader opens only the file of the instance it observed. One file per instance means no instance overwrites another's evidence: a previous owner still reaping children after it released the lock writes its own record even if a successor has taken the slot, started, and ended meanwhile.
- The record is staged under an exclusive name and renamed into place (mode 0600), so a reader sees no record or the whole record, never a partial file. It never carries the lock token.
- A serve that never took the lock writes no record (I3). A start that fails after the lock was taken records `failed`.
- Retention: the lock owner, right after it takes the lock, keeps the newest `CONSOLE_EXIT_RECORD_RETAIN` (16) records and removes older ones whose pid is ESRCH, along with abandoned staging files whose writer is ESRCH. Nobody else removes records.

| Outcome | Written by | Meaning |
|---|---|---|
| `clean` | the Console, at exit | the shutdown finished and the process exited on its own |
| `deadline` | the Console, at exit | B_int ran out; `killed` counts the owned process groups and other leftover children it SIGKILLed |
| `crash` | the Console, at exit | an uncaught exception ended it |
| `failed` | the Console, at exit | it took the lock, then its start or its shutdown failed, and it ended with an error |
| `external` | the containment watcher *(pending)*, or inferred by a reader of a Console that reports `lifecycleWire` | the process vanished without a record |
| `forced-external` | the actor that sent SIGKILL (the CLI; Desktop and the update worker *(pending)*) | escalation after B_ext |

A reader that finds no record for the instance it observed decides from the lock's `version` and the health `lifecycleWire` whether the Console predates the contract; a pre-contract Console keeps its old meaning (no record).

New outcomes may be added without a version change. A reader that meets an outcome it does not know, or a record file for the instance that it cannot read (another version, malformed, a symlink, naming another instance), treats it as `unknown` and never reports it as a clean stop (fail closed): a newer Console may describe an ending an older reader cannot interpret.

## Wire compatibility

- The lock payload and the meaning of health answers do not change; additions only. The authenticated health answer carries `lifecycleWire: CONSOLE_LIFECYCLE_WIRE`. Its absence means wire 0 (before this contract).
- An observer that meets a wire newer than its own treats that instance as unverified: it neither signals it nor removes its lock on that basis.
- Shipped Desktop builds and update workers carry frozen copies of the contract. The published `./desktop-protocol` export surface is unchanged by it.

## Observing an instance from outside

An external actor reads the lock, the pid's liveness (only ESRCH is death), and the token-authenticated health endpoint, and classifies the instance with `classifyConsoleInstance` (through `observeConsoleInstance`). The CLI does; Desktop, the update worker, and the local Console list still apply their own reading *(pending)*.

| Lock | Pid | Health | Observed | May do |
|---|---|---|---|---|
| none | — | — | absent | start |
| owner | ESRCH | — | exited, lock left behind | nothing; the next `serve` reclaims it |
| trusted | alive | 200, same pid, `lifecycleWire` not newer than the observer's | ready | the actor that requests the stop may SIGTERM |
| trusted | alive | 503 `console_starting`, same pid | starting | wait within its start budget; only its own parent may stop it |
| trusted, same bytes as before | alive | refused | **stopping** | wait up to B_ext; never SIGTERM again |
| gone or replaced since observed | alive | — | releasing | wait for the process; never SIGKILL — the Console's own deadline bounds it |
| trusted | alive | timeout, 401/404, other pid | unverified | nothing |
| untrusted or tokenless | alive | — | unverified | nothing |
| symlink, another user's, or no readable owner | — | — | blocked | nothing; manual recovery text |

A refused endpoint with a live pid that still holds the same lock is a Console that has closed its listener and is cleaning up — never an absent owner. The pre-contract helper `identifyConsoleLockOwner` in `@fleet-console/protocol/desktop` still maps that case to `absent`; its remaining consumers correct for it and it is removed when the last of them moves onto the contract.

### Stop ladder

An actor that asks a Console to stop:

1. Observes it. If it is stopping, releasing, or exited, it does not request again.
2. Proves its identity: an unreaped own child handle, a parent link (POSIX), or an authenticated health answer with the same pid — plus the process start time when health was the proof.
3. Sends SIGTERM once.
4. Waits, on a monotonic deadline, until the pid exits or the same lock instance is released, up to B_ext.
5. If it saw the release, it sends nothing more and reads the exit record once the process is gone.
6. Past B_ext with the lock still held, it proves identity again (own child, parent link, unchanged start time, or a fresh health answer). Without proof it signals nothing.
7. SIGKILL, then confirm the exit within `KILL_CONFIRM_MS`; the result is `forced-external`.

An actor that sees an instance someone else is stopping only waits, and reports it when it is still stopping after B_ext. A starter that gives up on its own child applies the ladder too once that child holds the lock — it may be writing durable state — and gives a child that has not taken the lock only `PRELOCK_CHILD_GRACE_MS` before SIGKILL; its unreaped child handle is its identity proof. On Windows `process.kill(pid, "SIGTERM")` terminates the process outright, so an actor never signals an instance that is already stopping there; it waits up to B_ext.

## Children

A Console's children must not outlive it on any exit path (I2).

### Owned process groups

- Every agent CLI the Console's SDK users start — Agent chat, Analyst, and the AI Gateway's routing model — goes through one spawn port (`ConsoleRuntimeContext.spawnAgentProcess`), and so does the Computer Use codex app-server. On POSIX each starts as the leader of a **process group of its own** and is registered in the Console's owned-process registry (`createOwnedProcessRegistry`); its MCP servers and tool processes stay in that group. The port is required where those children are composed, so none of them can be started without it.
- A child the Console hands off on purpose is never registered and never signalled by the Console: the detached update worker (and the Console it starts) and PTY sessions (their terminal ends them). A child a plugin starts in a group of its own (the ledger CLI) is not yet registered and so is reached by neither step below *(pending: the same port offered to plugins)*.
- On a normal stop the SDK closes each agent CLI (stdin close, SIGTERM to the leader after 2 s, SIGKILL after 5 more).
- When the stop deadline fires, the Console reads the process table **at most once**, when the first step below needs it, and both steps judge by that one snapshot; so the deadline adds at most one `PROCESS_TABLE_TIMEOUT_MS` to B_int, which is the delay B_ext is sized for. It first SIGKILLs the registered groups:
  - A group whose leader is still the Console's **unreaped child** is signalled as a whole without reading the process table: an unreaped child's pid, and so its group number, cannot be reused (E1). This is the common case — an agent CLI that ignored SIGTERM — and it needs no `ps`, so a process table that cannot be read in time no longer leaves orphans (follow-up e7874487:N8).
  - A group whose leader already exited but which still has members is signalled only when a `ps` snapshot proves them: no process holds the leader's pid, and every member started between the group's spawn (less the 2 s start-time margin) and now. If the table cannot be read within `PROCESS_TABLE_TIMEOUT_MS`, that group is left alone (I1 before I2) *(pending: the per-Console watcher retries)*.
  - Never the Console's own group (a Desktop sidecar shares Desktop's) and never a group number ≤ 1.
- Then, as a fallback, it SIGKILLs every **unregistered** descendant that still shares the Console's own process group (a plugin's tool, a git or ripgrep call, a stdio MCP transport that hung), deepest first, from that same snapshot. The only judgment is "same group as the Console": a child that leads a group of its own is either registered (already handled above) or handed off on purpose, and is never signalled here. Without a readable table this step signals nothing; the registered groups led by unreaped children were already ended without it.
- Windows has no process groups: a direct child is ended with the Console by libuv's job object; grandchildren are not yet measured *(pending: U2)*.
- A crash or an external SIGKILL is not yet covered *(pending: a per-Console watcher that reclaims the registered groups after re-proving each one)*. The real Claude Code CLI (2.1.289) does not exit on stdin EOF while a turn is open and survives its parent's SIGKILL together with its MCP children (measured, U1), so that watcher is required.

Because the Console spawns agent CLIs itself, the SDK no longer reads their stderr: the spawn adapter drains it (and forwards it to an SDK `stderr` callback when one is set) and delivers the exit once stderr has closed, as the SDK's own spawner does. The SDK's exit errors no longer end with a `stderr:` tail; instead the Console writes the last 2 KB of a CLI that exits with a non-zero code or an unexpected signal to its failure log (`agent_cli_exit` in `errors.jsonl`). The SDK's default debug file is not passed either; it only applies when SDK debugging is enabled.

### Console-owned temporary files

Launch prompt files and Quick Launch attachments live in temporary namespaces a Console owns. Each namespace is keyed by a hash of the **real path** of what it belongs to (the lock file for launch prompts, the data directory for attachments), so every spelling of one slot shares it. An entry's name carries its creator's pid. Only the lock owner reclaims leftovers, right after taking the lock, and only entries whose creator is ESRCH (or that an earlier process with this same pid left); an entry of a Console that is still running stays even when lock exclusivity was broken (follow-up f64f5d65). On shutdown a Console removes its own entries and removes the namespace root only when it is empty. Quick Launch attachments left by a Console from before this contract — entries without a creator pid, and a namespace keyed by a data-directory spelling that is not its real path — are never reclaimed; after an upgrade they stay under TMPDIR until the OS clears it.

## Rationale and history

The chain of lifecycle fixes #1527–#1565 each patched one actor's own copy of lock reading, identity proof, signalling, and a 10 s budget. The copies drifted: a refused endpoint meant "stopping" to one actor and "absent" to another, the external SIGKILL and the internal deadline were both 10 s and raced, an update's self-stop bypassed the shutdown that signals used, and a stop that the deadline ended was reported to the CLI as a clean stop. This contract puts each judgment in one place and lets actors choose only policy.
