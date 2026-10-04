# Console Lock Reclaim Across Hosts

How the Console lock (`console.lock` in the Console runtime slot) is released and reclaimed when Fleet Console, the `fleet` CLI, Fleet Desktop, and the Console update worker share one slot, including mixed releases. This page is the rationale and the known limits. The rules themselves live in `runtime/fleet-console/core/host/bootstrap/lock.ts` (reclaim protocol), `runtime/fleet-desktop/src/sidecar-supervisor.ts` (Desktop's side), and the worker script in `runtime/fleet-console/features/updates/host/update-apply.ts` (the update's side).

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
3. **Start `serve`.** `serve`'s `acquireLock` reclaims an exited Console's lock. If it does not take the lock, it exits with `CONSOLE_SERVE_EXIT_LOCK_HELD` (73). Before exiting it writes the lock text to stderr once, as plain text that can span several lines (for example `EEXIST: … is already held.` followed by `… is held by running pid N.`), and records it as one JSON entry in the Console failure log (`errors.jsonl` in the data directory, size-capped). Desktop reports that as `console_lock_held`, with the stderr tail in the dialog.
4. **Quit** never removes a lock. An exited Console's lock is left for the next start.

현재 `serve`는 실제 loopback 포트를 먼저 bind하되 요청과 upgrade를 차단하고, `acquireLock` 뒤에만 settings 초기화·legacy 승계·durable 복원·execution·plugin·remote 초기화를 수행한다. 패자는 자기 listener를 닫고 exit 73으로 끝나며, lock 프로토콜의 staging과 `lock_held` 진단 외에는 제품 상태를 쓰지 않는다. Desktop의 사전 slot 판정은 그대로 유지한다. 구버전 runtime의 lock 전 쓰기를 피하고, live owner 옆에 불필요한 child를 띄우지 않기 위해서다.

초기화 중인 lock 소유자의 token-authenticated health는 `503 {"error":"console_starting","pid":…}`를 반환한다. CLI `ensureDaemon`은 기존 startup 예산(기본 60초), Desktop `probeForStart`는 기존 launch 예산(40회, delay 최대 1초) 안에서 live PID의 이 응답만 기다린다. 준비 뒤에만 기존 healthy/owner 호환 판정을 적용한다. 일반 unhealthy 503과 구분하며, starting 자체는 신호나 lock 삭제 권한이 아니다. 구버전 Desktop의 자기 child 대기는 non-healthy를 이미 재시도하지만, 다른 시작의 initializing lock 채택은 이 starting 처리를 포함한 Desktop부터 기다린다.

### Legacy branch: runtimes without the reclaim protocol

Console releases up to and including **1.212.0** publish the lock with `O_EXCL` alone and never reclaim. With such a runtime, nothing would clear a crashed Console's lock, and Desktop would fail to start after every crash. So, for that runtime only, Desktop keeps its old removal: unlink the lock only while its contents equal what it judged dead.

- **Condition:** a packaged Desktop (`legacyLockCleanup`), and a runtime version that `isPreReclaimConsoleVersion` accepts: a plain `major.minor.patch` that is ≤ 1.212.0. A prerelease, build metadata, an empty value, or any other form is treated as unknown, and an unknown runtime takes the delegated path. Development runtimes never take this branch, because the repository version does not say whether the code has the protocol.
- **Remaining TOCTOU:** the compare-then-unlink is not part of the reclaim chain. A CLI `start`/`stop` that reclaims at the same time can finalize, and a new Console can publish, between Desktop's compare and its unlink. Desktop would then remove a live lock. This affects only the legacy-runtime combination, where `serve` itself does not take part in the protocol.
- **Misjudgment limits:**
  - A pre-1.212.0 *prerelease* runtime is classified as unknown. It takes the delegated path, its `serve` cannot reclaim, and Desktop refuses to start after a crash, with guidance.
  - A 1.212.x hotfix built from a branch without #1552 would be classified as reclaim-capable. The current release flow ships from `canary`, so that branch does not exist today.
- **Removal:** delete the branch, `isPreReclaimConsoleVersion`, and `legacyLockCleanup` when the oldest Console runtime Desktop will start is raised above 1.212.0.

### Mixed releases

"New" means a release with the reclaim protocol and the delegation. D = first Desktop with the delegation; X = first Console release after 1.212.0. The update worker is emitted by the Console being updated, so its behavior follows that Console's release, not the target's.

| # | Desktop | Console runtime | Outcome and limits |
|---|---|---|---|
| R1 | ≥ D | ≥ X | Every removal of another's lock goes through the reclaim chain. |
| R2 | ≥ D | ≤ 1.212.0 (offline, a failed install, or a lagging release check) | Legacy branch: Desktop clears an exited Console's lock itself (remaining TOCTOU above). A pre-1.212.0 prerelease is unknown and blocks the start instead. |
| R3 | < D (≤ 0.17.1) | ≥ X | Old Desktop still compares and unlinks before it starts `serve`, outside the reclaim chain, and stops with `console_lock_malformed` on an ownerless lock. Only a Desktop update fixes this. `serve` still reclaims what Desktop leaves. Exit status 73 reaches the old Desktop as `sidecar_exited_before_ready: code=73` with the generic dialog, the same path as exit status 1 before; the lock text is only in the Desktop log. |
| R4 | – | Updating from ≤ 1.212.0 to ≥ X | The worker comes from the old Console, so it still removes the exited Console's lock itself (pid and token compare, then `rmSync`), outside the reclaim chain, for this one update. The new `serve` reclaims whatever is left. Updates from X onward delegate. |
| R5 | – | Updating from ≥ X to a target ≤ 1.212.0 (a downgrade or an experimental tag), or a failed install whose recovery starts pre-X code | The worker no longer clears the lock and the pre-X `serve` cannot reclaim. A lock left by the old Console (only after a crash or a SIGKILL escalation; a Console stopped by SIGTERM releases its own) makes both the new daemon and the recovery exit early, so the update fails quickly and leaves no Console running. The progress record and the update log say so. Starting Console again handles the lock by the rules of whatever starts it. |
| R6 | – | ≥ X, old Console SIGKILLed and its pid reused before the new `serve` starts | `serve` sees a live owner and exits 73; the update fails within seconds. Recovery is then skipped (#1557: the old lock is still held and its pid is alive). The user has to confirm that pid and clear the lock by hand. The worker used to remove that lock on the parent-exit proof; ESRCH as the only death evidence costs this rare case. |
| R7 | any | any, with a pre-X `fleet` CLI running against the same slot | The old CLI's untrusted-lock cleanup and `removeLock` stay outside the chain until the CLI is updated. |
| R8 | ≥ D on Windows | ≥ X | A reclaim marker needs hard links. On a volume without them the reclaim fails, `serve` exits 73, and Desktop shows the guidance. The default temporary directory (NTFS) has hard links. |

### Remaining races and limits

- **Start versus another starter.** Desktop의 마지막 slot 판정과 `serve`의 `acquireLock` 사이에 다른 시작이 이길 수 있다. 현재 runtime은 이 경쟁에서 제품 상태를 쓰기 전에 패배하므로 두 writer가 복원을 실행하지 않는다. 이 순서 변경 전의 runtime에는 lock 전 쓰기 창이 남아 있으므로, Desktop의 사전 판정만으로 구버전의 동시 시작까지 막는다고 보장하지 않는다.
- **Waiting on a closing Console.** After it sends SIGTERM, Desktop treats a Console that refuses connections but is still alive as "closing" and waits for ESRCH before it starts. In the current flows this path is defensive only: the startup termination path is reached only for Desktop's own child, which is escalated to SIGKILL and awaited until ESRCH. The effective protections are the startup settle wait (refused endpoint + live pid) and the second slot judgement just before the start.
- **Untrusted lock with a live pid.** Its endpoint cannot be asked, so Desktop never proves its identity. The user has to check that pid by hand.
- **Pid reuse.** A crashed Console's pid can be reused by an unrelated live process. Every participant then sees a live owner and refuses. The guidance asks the user to confirm and delete the lock by hand.

## Console update worker

The worker that applies a Console update stops the old Console, installs the target, and starts the new Console. It runs as a standalone script and cannot use `lock.ts`, so, like Desktop, it no longer removes a lock: after the old Console is proven gone it logs the lock state (`held`, `missing`, `replaced`, or `unreadable`) and leaves the lock for the new `serve` to reclaim.

- **Its daemons run without stdio, like every detached Console.** The `serve` outlives the worker, so nothing could keep reading or bounding its output. A `serve` that does not take the lock records why (the holder, or the manual-recovery steps) in the Console failure log, `errors.jsonl` in the data directory. That log is size-capped and rotated once. The worker's run log records the lock state the worker last saw and names that file. The failure text in the progress record names the file without its path, because that record reaches the browser.
- **An early exit ends the wait.** The new daemon and the failure recovery both watch their `serve`'s exit. Each poll looks for a healthy Console first and checks the exit only after that. If no healthy Console answers, exit status 73 (`CONSOLE_SERVE_EXIT_LOCK_HELD`) fails the step at once with "did not take the Console lock", and any other exit before health fails it with the exit code. Neither waits out the 60 s start timeout.
- **spawn 전 health 선판정.** 새 daemon 단계는 이전 PID와 다른 lock이 목표 버전의 healthy Console을 가리키면 spawn 없이 성공한다. recovery는 살아 있는 lock PID의 healthy Console이 있으면 버전과 무관하게 spawn을 생략한다. 그 뒤에도 #1557의 old pid·token lock 보존 판정은 유지한다. 기존 old lock을 살아 있는 PID가 계속 쥐고 있으면 recovery는 spawn하지 않는다. 시작하지 않은 상태나 일반 health 실패를 죽음의 증거로 쓰지 않는다.

Remaining limits of the worker:

- **Another starter can take the slot between the old Console's exit and the new `serve`'s `acquireLock`.** Examples are a Desktop launch or a CLI `start`. Its lock is kept in every case, and the outcome depends on what it serves:
  - If it is healthy and reports the target version, the new daemon step accepts it and the update completes.
  - Otherwise, the new `serve` exits 73 and the update fails quickly with that reason, even though the target is already installed.
  - Recovery after a failed step treats any healthy Console on the lock as recovered.
  현재 runtime에서는 이 경쟁의 패자도 durable 복원 전에 거부된다. 구버전 runtime의 lock 전 쓰기 제한은 Desktop 절의 설명과 같다.
- **선판정 뒤 경쟁은 남는다.** health 선판정 뒤 다른 Console이 slot을 차지하거나, 이미 lock을 쥔 Console이 아직 starting일 수 있다. worker는 기존 spawn 후 health-first/exit-second poll을 유지한다. 현재 `serve`는 lock 패배 시 제품 상태를 쓰지 않지만, exit 73과 `errors.jsonl`의 `lock_held` 진단은 남길 수 있다. 선판정은 중복 spawn을 줄이는 보완이며 single-writer 보장은 Console의 acquireLock 경계가 맡는다.
- **The worker's verdict that the old Console is gone can rest on the parent link alone.** On POSIX, a worker reparented away from the old Console counts it as exited. Only the new `serve`'s ESRCH check decides whether its lock is reclaimed, so a reused pid ends in R6 rather than in a wrong removal.
