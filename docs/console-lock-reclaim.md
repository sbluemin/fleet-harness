# Console Lock Reclaim Across Hosts

How the Console lock (`console.lock` in the Console runtime slot) is released and reclaimed when Fleet Console, the `fleet` CLI, Fleet Desktop, and the Console update worker share one slot, including mixed releases. This page is the rationale and the known limits. The rules themselves live in `runtime/fleet-console/core/host/bootstrap/lock.ts` (reclaim protocol) and `runtime/fleet-desktop/src/sidecar-supervisor.ts` (Desktop's side).

## The rule

- A Console removes **its own** lock on exit (pid guard).
- Only the reclaim protocol in `lock.ts` removes **someone else's** lock. It requires a lock whose pid is ESRCH right now, the exact bytes that were judged, and the newest reclaim marker for those bytes. Participants are `serve` (inside `acquireLock`), CLI `start`/`stop`, and the CLI's cleanup of a child it spawned.
- A lock with no readable owner (empty, invalid JSON, not an object, invalid pid, unreadable, not a regular file) is never removed by anyone. A symlink or a lock owned by another user is refused and also never removed. A person clears both by hand, following the text in `describeOwnerlessConsoleLock` / `describeRefusedConsoleLock` (`@fleet-console/protocol/desktop`).
- Elapsed time, a refused endpoint, or an unchanged file is never proof that an owner is gone. Only ESRCH counts.

## Fleet Desktop

Desktop cannot import `lock.ts` (Console internals), so it does not take part in the reclaim protocol. It never removes a lock, except in the legacy branch below. Instead it decides only **whether to start** a Console, and leaves the reclaim to the `serve` it starts.

1. **Judge the slot.** Desktop reads the lock with the same classification as `lock.ts` (`classifyConsoleLockContent` plus its own lstat/uid checks):
   - absent → may start;
   - refused or ownerless (ownerless is re-read for 2 s first) → no start, the dialog shows the Console recovery text, the lock stays;
   - an owner whose fields cannot be trusted → if its pid is alive, unverified (conflict dialog); if ESRCH, may start;
   - a trusted owner → the existing adopt / conflict / identity flow. A refused endpoint with a live pid is waited on (`SHUTDOWN_SETTLE_MS`), because a Console that is shutting down closes its listener first and releases the lock last.
2. **Resolve the runtime** (procurement can take long), then **judge the slot again**. It starts only if that second judgement also finds the slot absent or the owner pid ESRCH.
3. **Start `serve`.** `serve`'s `acquireLock` reclaims an exited Console's lock. If it does not take the lock, it exits with `CONSOLE_SERVE_EXIT_LOCK_HELD` (73) after writing the lock text to stderr. Desktop reports that as `console_lock_held`, with the stderr tail in the dialog.
4. **Quit** never removes a lock. An exited Console's lock is left for the next start.

Desktop decides whether to start, and does not leave that to `serve`'s refusal, because `serve` restores durable state, boots plugins, and binds its port **before** `acquireLock`. A `serve` that loses the lock has already touched shared data next to the owner.

### Legacy branch: runtimes without the reclaim protocol

Console releases up to and including **1.212.0** publish the lock with `O_EXCL` alone and never reclaim. With such a runtime, nothing would clear a crashed Console's lock, and Desktop would fail to start after every crash. So, for that runtime only, Desktop keeps its old removal: unlink the lock only while its contents equal what it judged dead.

- **Condition:** a packaged Desktop (`legacyLockCleanup`), and a runtime version that `isPreReclaimConsoleVersion` accepts: a plain `major.minor.patch` that is ≤ 1.212.0. A prerelease, build metadata, an empty value, or any other form is treated as unknown, and an unknown runtime takes the delegated path. Development runtimes never take this branch, because the repository version does not say whether the code has the protocol.
- **Remaining TOCTOU:** the compare-then-unlink is not part of the reclaim chain. A CLI `start`/`stop` that reclaims at the same time can finalize, and a new Console can publish, between Desktop's compare and its unlink. Desktop would then remove a live lock. This affects only the legacy-runtime combination, where `serve` itself does not take part in the protocol.
- **Misjudgment limits:**
  - A pre-1.212.0 *prerelease* runtime is classified as unknown. It takes the delegated path, its `serve` cannot reclaim, and Desktop refuses to start after a crash, with guidance.
  - A 1.212.x hotfix built from a branch without #1552 would be classified as reclaim-capable. The current release flow ships from `canary`, so that branch does not exist today.
- **Removal:** delete the branch, `isPreReclaimConsoleVersion`, and `legacyLockCleanup` when the oldest Console runtime Desktop will start is raised above 1.212.0.

### Mixed releases

"New" means a release with the reclaim protocol and the Desktop delegation. D = first Desktop with the delegation; X = first Console release after 1.212.0.

| # | Desktop | Console runtime | Outcome and limits |
|---|---|---|---|
| R1 | ≥ D | ≥ X | Every removal of another's lock goes through the reclaim chain. |
| R2 | ≥ D | ≤ 1.212.0 (offline, a failed install, or a lagging release check) | Legacy branch: Desktop clears an exited Console's lock itself (remaining TOCTOU above). A pre-1.212.0 prerelease is unknown and blocks the start instead. |
| R3 | < D (≤ 0.17.1) | ≥ X | Old Desktop still compares and unlinks before it starts `serve`, outside the reclaim chain, and stops with `console_lock_malformed` on an ownerless lock. Only a Desktop update fixes this. `serve` still reclaims what Desktop leaves. Exit status 73 reaches the old Desktop as `sidecar_exited_before_ready: code=73` with the generic dialog, the same path as exit status 1 before; the lock text is only in the Desktop log. |
| R4 | – | – | *Update worker: see below.* |
| R5 | – | – | *Update worker: see below.* |
| R6 | – | – | *Update worker: see below.* |
| R7 | any | any, with a pre-X `fleet` CLI running against the same slot | The old CLI's untrusted-lock cleanup and `removeLock` stay outside the chain until the CLI is updated. |
| R8 | ≥ D on Windows | ≥ X | A reclaim marker needs hard links. On a volume without them the reclaim fails, `serve` exits 73, and Desktop shows the guidance. The default temporary directory (NTFS) has hard links. |

### Remaining races and limits

- **Start versus another starter.** Desktop's last ESRCH judgement and `serve`'s `acquireLock` are separated by `serve`'s pre-lock work. A CLI `start` or another `serve` that begins in that window can make two processes touch durable state before one loses the lock. This is the same window two concurrent CLI starts have. Closing it needs the Console to take the lock before it restores state. That is a Console change, tracked separately.
- **Waiting on a closing Console.** After it sends SIGTERM, Desktop treats a Console that refuses connections but is still alive as "closing" and waits for ESRCH before it starts. In the current flows this path is defensive only: the startup termination path is reached only for Desktop's own child, which is escalated to SIGKILL and awaited until ESRCH. The effective protections are the startup settle wait (refused endpoint + live pid) and the second slot judgement just before the start.
- **Untrusted lock with a live pid.** Its endpoint cannot be asked, so Desktop never proves its identity. The user has to check that pid by hand.
- **Pid reuse.** A crashed Console's pid can be reused by an unrelated live process. Every participant then sees a live owner and refuses. The guidance asks the user to confirm and delete the lock by hand.

## Console update worker

*To be completed after the update worker change (`runtime/fleet-console/features/updates/host/update-apply.ts`) lands: the removal of the worker's own lock deletion, the stderr routing of the daemons it starts, and rows R4–R6 (a worker emitted by a pre-X Console; a downgrade target or a recovery that starts pre-X code; SIGKILL followed by pid reuse).*
