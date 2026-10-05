# Console Process Lifecycle Contract

One Console `serve` process has one lifecycle, and every actor that deals with it — the serve process itself, CLI `start`/`stop`/`restart`, the Fleet Desktop sidecar supervisor, the Console update worker and its recovery, and the local Console list — follows this contract instead of its own judgment. This page is the contract and its rationale. The code lives in two places:

- `@fleet-console/protocol/lifecycle` (`runtime/fleet-console/protocol/lifecycle/`): the pure contract — states, time budgets, the exit record schema, and lock-slot classification.
- `@fleet-console/lifecycle` (`runtime/fleet-console/foundation/lifecycle/`): observation and IO — pid liveness and reading and writing exit records.

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

### One stop request, one shutdown

- Every way a Console is asked to stop is the same request: SIGTERM or SIGINT, an accepted in-place update stopping itself, and a programmatic `server.stop()`. The first request moves the instance to *stopping*, arms the deadline, and starts the single cleanup; every later request receives that same cleanup and never starts another. A request during startup waits for startup to settle before the cleanup runs, so a writer that is still restoring state never loses its lock under it.
- The lock is released once, at the very end of that cleanup. No request — the first or any later one — settles before then, so no caller sees a Console as stopped while it still holds the lock and runs cleanup. (Before this contract an update's self-stop did not arm the deadline, and a SIGTERM arriving during it returned before the cleanup and the lock release: follow-up 3b17763a.)
- The signal handlers are installed before the lock is published and stay until the process exits, including *releasing*, where the SDK may still be reaping a child that ignored SIGTERM. Later signals are accepted and ignored.
- An uncaught exception while *ready* exits at once with status 1 (outcome `crash`); children are left to the containment described under [Children](#children). During *stopping* or *releasing* it only sets the exit status to 1 and lets the cleanup or the deadline finish.

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

A Console instance that held the lock writes `console.exit.json` beside its lock as its process exits (`consoleExitRecordPath(lockFile)`):

```json
{ "v": 1, "pid": 4242, "lockStartedAt": 1791163806746, "outcome": "deadline", "killed": 2, "at": 1791163817000 }
```

- `pid` and `lockStartedAt` (the `startedAt` of the lock that instance published) pair the record with the instance a reader observed. A record for another pair says nothing about that instance; only the last ending is kept.
- The record is staged under an exclusive name and renamed into place (mode 0600), so a reader sees the previous record or the new one, never a partial file. It never carries the lock token.
- A serve that never took the lock writes no record (I3). A start that fails after the lock was taken records `crash`.

| Outcome | Written by | Meaning |
|---|---|---|
| `clean` | the Console, at exit | the shutdown finished and the process exited on its own |
| `deadline` | the Console, at exit | B_int ran out; `killed` leftover children were SIGKILLed |
| `crash` | the Console, at exit | an uncaught exception, a failed shutdown, or a failed start |
| `external` | the containment watcher *(pending)*, or inferred by a reader | the process vanished without a record |
| `forced-external` | the actor that sent SIGKILL *(pending)* | escalation after B_ext |

A reader that finds no record for the instance it observed decides from the lock's `version` and the health `lifecycleWire` whether the Console predates the contract; a pre-contract Console keeps its old meaning (no record).

## Wire compatibility

- The lock payload and the meaning of health answers do not change; additions only. The authenticated health answer carries `lifecycleWire: CONSOLE_LIFECYCLE_WIRE`. Its absence means wire 0 (before this contract).
- An observer that meets a wire newer than its own treats that instance as unverified: it neither signals it nor removes its lock on that basis.
- Shipped Desktop builds and update workers carry frozen copies of the contract. The published `./desktop-protocol` export surface is unchanged by it.

## Observing an instance from outside

An external actor reads the lock, the pid's liveness (only ESRCH is death), and the token-authenticated health endpoint. *(pending: these rules become one shared classifier as each actor moves onto the contract.)*

| Lock | Pid | Health | Observed | May do |
|---|---|---|---|---|
| none | — | — | absent | start |
| owner | ESRCH | — | exited, lock left behind | nothing; the next `serve` reclaims it |
| trusted | alive | 200, same pid | ready | the actor that requests the stop may SIGTERM |
| trusted | alive | 503 `console_starting`, same pid | starting | wait within its start budget |
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

An actor that sees an instance someone else is stopping only waits. On Windows `process.kill(pid, "SIGTERM")` terminates the process outright, so an actor never signals an instance that is already stopping there; it waits up to B_ext.

## Children

A Console's children must not outlive it on any exit path (I2). Today the normal shutdown and the deadline cover them on POSIX: the SDK closes each agent CLI (stdin close, SIGTERM after 2 s, SIGKILL after 5 more), and the deadline SIGKILLs descendants still in the Console's process group, leaving alone a child that leads its own group (the detached update worker, PTY sessions). A crash or an external SIGKILL is not yet covered *(pending: an owned-child registry, agent CLIs in their own process groups, and a per-Console watcher that reclaims them after re-proving each group's identity)*.

## Rationale and history

The chain of lifecycle fixes #1527–#1565 each patched one actor's own copy of lock reading, identity proof, signalling, and a 10 s budget. The copies drifted: a refused endpoint meant "stopping" to one actor and "absent" to another, the external SIGKILL and the internal deadline were both 10 s and raced, an update's self-stop bypassed the shutdown that signals used, and a stop that the deadline ended was reported to the CLI as a clean stop. This contract puts each judgment in one place and lets actors choose only policy.
