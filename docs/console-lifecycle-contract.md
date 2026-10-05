# Console Process Lifecycle Contract

One Console `serve` process has one lifecycle, and every actor that deals with it — the serve process itself, CLI `start`/`stop`/`restart`, the Fleet Desktop sidecar supervisor, the Console update worker and its recovery, and the local Console list — follows this contract instead of its own judgment. This page is the contract and its rationale. The code lives in two places:

- `@fleet-console/protocol/lifecycle` (`runtime/fleet-console/protocol/lifecycle/`): the pure contract — states, time budgets, the instance classifier (`classifyConsoleInstance`), the exit record schema, and lock-slot classification.
- `@fleet-console/lifecycle` (`runtime/fleet-console/foundation/lifecycle/`): observation and IO — pid liveness and process start times, the token-authenticated health probe, instance observation (`observeConsoleInstance`), the stop ladder (`runStopLadder`), exit records, the owned-process registry, and Console-owned temporary namespaces.

The serve state owner is `runtime/fleet-console/core/host/bootstrap/serve-lifecycle.ts`. Lock publication and the reclaim of another instance's lock are a separate, referenced contract: [Console Lock Reclaim Across Hosts](console-lock-reclaim.md).


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

The reaper's states move with the Console's (see [Children](#children)):

| Console | Reaper |
|---|---|
| binding | none — a lock loser never starts one |
| starting (the lock was just published, before any owned child) | **armed**; it fails to start → `reaper_degraded` |
| ready · stopping · releasing | armed; replaced once if it ends, then degraded |
| exited, any way | **draining** (pipe end or its liveness check) → **gone** within `REAPER_DRAIN_MAX_MS` |

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
| `LOCK_OBSERVE_BUDGET_MS` | 2 s | How long a lock without a readable owner is read again (every `LOCK_REREAD_INTERVAL_MS`, 50 ms) before it is reported, and how long a lock acquirer waits on another reclaimer. Elapsed time is never evidence that the owner is dead. |
| `OWNED_GROUP_TERM_GRACE_MS` | 2 s | From SIGTERM to SIGKILL for an owned process group: the Console's stop path for its plugins' groups and the reaper after a crash use this one value, the same gap as the agent SDK's. With the one process-table read the stop path may take when that grace ends, it must hold `OWNED_GROUP_TERM_GRACE_MS + PROCESS_TABLE_TIMEOUT_MS + ε < B_int − ESCALATION_MARGIN_MS` (3 s ≪ 9 s). |
| `INTERACTIVE_PROBE_TIMEOUT_MS` | 2 s | One health probe on a path a person waits on, such as quitting Desktop. A probe that times out proves nothing, so nothing is signalled. The CLI's identity probe keeps `HEALTH_PROBE_TIMEOUT_MS` (5 s). |

Why B_ext is derived: an external SIGKILL that lands at the same moment as the Console's own deadline races the Console's cleanup of its children. Polling phase only ever delays an external escalation, so the margin needed is the Console's own worst-case delay: its process-table read plus event-loop lag. With B_ext = B_int + that delay, a Console within its own budget always finishes first (I4). A Console whose loop is blocked for more than a second at signal time can still lose that race; containment must then still leave no children (I2).

## Exit record

A Console instance that held the lock writes its own exit record beside its lock as its process exits, named by its instance key: `console.exit.<pid>-<lockStartedAt>.json` (`consoleExitRecordPath(lockFile, instance)`).

```json
{ "v": 1, "pid": 4242, "lockStartedAt": 1791163806746, "outcome": "deadline", "killed": 2, "at": 1791163817000 }
```

- `pid` and `lockStartedAt` (the `startedAt` of the lock that instance published) are the instance key. A reader opens only the file of the instance it observed. One file per instance means no instance overwrites another's evidence: a previous owner still reaping children after it released the lock writes its own record even if a successor has taken the slot, started, and ended meanwhile.
- The record is staged under an exclusive name and renamed into place (mode 0600), so a reader sees no record or the whole record, never a partial file. It never carries the lock token.
- A serve that never took the lock writes no record (I3). A start that fails after the lock was taken records `failed`.
- One instance's record can have more than one writer, and the writer that knows most wins whatever order they write in: the Console's own outcome, then `forced-external`, then `external`. The Console's own record replaces anything. The actor that sent SIGKILL replaces only no record or an `external` one. The reaper only creates the file, exclusively, and never replaces a record. Both outside outcomes are abnormal endings, so the order never changes whether a stop counts as clean. The actor that sent SIGKILL reports the record it left in place when the Console's own record was already there. An entry at the record path that cannot be read as this instance's record — a corrupt file, a directory, a symlink, or a record from another version — is never replaced either: it may be an ending a newer Console wrote that this reader cannot interpret, so the actor that sent SIGKILL then reports `unknown` (fail closed), accepting that a truly corrupt entry hides the forced stop. If the reaper cannot create its `external` record (a volume without hard links), a reader reaches the same ending: no record from a Console that reports `lifecycleWire` reads as `external`.
- Retention: the lock owner, right after it takes the lock, keeps the newest `CONSOLE_EXIT_RECORD_RETAIN` (16) records and removes older ones whose pid is ESRCH, along with abandoned staging files whose writer is ESRCH. Nobody else removes records.

| Outcome | Written by | Meaning |
|---|---|---|
| `clean` | the Console, at exit | the shutdown finished and the process exited on its own |
| `deadline` | the Console, at exit | B_int ran out; `killed` counts the owned process groups and other leftover children it SIGKILLed |
| `crash` | the Console, at exit | an uncaught exception ended it |
| `failed` | the Console, at exit | it took the lock, then its start or its shutdown failed, and it ended with an error |
| `external` | the Console's reaper, or inferred by a reader of a Console that reports `lifecycleWire` | the process vanished without a record (SIGKILL, or a frozen loop killed from outside) |
| `forced-external` | the actor that sent SIGKILL (the CLI, Desktop, the update worker) | escalation after B_ext |

A reader that finds no record for the instance it observed decides from the health `lifecycleWire` whether the Console predates the contract (`readConsoleEnding`): a Console that reported wire 1 or later and left no record was ended from outside (`external`), never a clean stop; a pre-contract Console, or one the reader itself terminated on Windows, is `unrecorded`: it cannot be blamed for the missing record.

New outcomes may be added without a version change. A reader that meets an outcome it does not know, or a record file for the instance that it cannot read (another version, malformed, a symlink, naming another instance), treats it as `unknown` and never reports it as a clean stop (fail closed): a newer Console may describe an ending an older reader cannot interpret.

## Wire compatibility

- The lock payload and the meaning of health answers do not change; additions only. The authenticated health answer carries `lifecycleWire: CONSOLE_LIFECYCLE_WIRE`. Its absence means wire 0 (before this contract).
- An observer that meets a wire newer than its own treats that instance as unverified: it neither signals it nor removes its lock on that basis. Adopting sends no signal, so Desktop still adopts a Console of a compatible owner whose authenticated health answers with the lock's own pid, whatever wire it reports. A Quit then signals a newer-wire Console only when it is this Desktop's own unreaped child (E1); any other newer-wire Console it adopted is left running, and the Quit logs it.
- A change that raises the wire must not lengthen `CONSOLE_STOP_DEADLINE_MS` (B_int) without settling the escalation hierarchy again: an older Desktop or CLI still SIGKILLs its own child after its own, older B_ext, which a longer internal deadline would put before the Console's deadline ends it (I4). The PR that first raises the wire decides it — keep B_int from growing, or give actors a rule that holds SIGKILL for a newer-wire child.
- Shipped Desktop builds and update workers carry frozen copies of the contract. The published `./desktop-protocol` export surface is unchanged by it.

## Observing an instance from outside

An external actor reads the lock through the one lock observer, `observeConsoleLockFile` in `@fleet-console/lifecycle` (absent, refused, no readable owner, or an owner with its exact bytes, liveness, and the first trust problem, if any), then the pid's liveness (only ESRCH is death) and the token-authenticated health endpoint, and classifies the instance with `classifyConsoleInstance` (through `observeConsoleInstance`). The CLI, `serve`, Desktop, the update worker, and the local Console list do. A trusted lock has the POSIX modes 0700/0600, belongs to this user, names the loopback host and a valid port, has an endpoint of exactly `http://<host>:<port>/`, a token, and a numeric `startedAt`; a shell may add its own adoption policy on top. Whether the lock still holds one instance is `consoleLockInstanceState` over the same observer: `released` when there is no lock or it names another pid (or token), `held` when it names that instance, and `unknown` when it cannot be judged — a lock without a readable owner, even one that parses (`{}`, `null`), is never taken as released.

| Lock | Pid | Health | Observed | May do |
|---|---|---|---|---|
| none | — | — | absent | start |
| owner | ESRCH | — | exited, lock left behind | nothing; the next `serve` reclaims it |
| trusted | alive, but started more than `LOCK_AUTHOR_REPLACED_MARGIN_MS` after the lock was written | refused | **replaced**: another program reused an ended Console's pid | nothing: no signal, no removal, no new `serve`; report the lock as blocked (`describeReplacedLockAuthor`) until that pid exits |
| trusted | alive | 200, same pid, `lifecycleWire` not newer than the observer's | ready | the actor that requests the stop may SIGTERM |
| trusted | alive | 503 `console_starting`, same pid | starting | wait within its start budget; only its own parent may stop it |
| trusted, same bytes as before | alive | refused | **stopping** | wait up to B_ext; never SIGTERM again |
| gone or replaced since observed | alive | — | releasing | wait for the process; never SIGKILL — the Console's own deadline bounds it |
| trusted | alive | timeout, 401/404, other pid | unverified | nothing |
| untrusted or tokenless | alive | — | unverified | nothing |
| symlink, another user's, or no readable owner | — | — | blocked | nothing; manual recovery text |

A refused endpoint with a live pid that still holds the same lock is a Console that has closed its listener and is cleaning up — never an absent owner.

Evidence direction: only ESRCH grants an action that frees the slot — removing a lock, signalling as an absent owner, or starting a new `serve`. A comparison of two wall-clock readings taken at different times (the lock's `startedAt` against the pid's `ps` start time) may only block an action. This limit covers only that comparison between a lock and a process; the identity proofs that compare a process with itself or with its own registration still grant a signal as this contract describes them — an unchanged start time read again (E4), and a registered group's spawn time against `ps` in the deadline and the reaper. So a live pid that started after its lock was written is `replaced`, not `exited`: every actor leaves it and its lock alone, and `serve` itself would not take that lock while the pid runs.

### Without credentials: the local Console list

The local Console list reads no lock token (#1563), so it observes in a public mode with the same rules and no authority to act (`observeConsolePublic`, `classifyConsolePublic`). It reads each lock through the same observer and leaves out a lock that fails the trust checks, since the list would take a person to its address. A Console on this machine is alive unless its pid is ESRCH; a Console inside WSL has a pid from another namespace, so a TCP connect to its port stands in. One unauthenticated `/api/v1/status` request, within `PUBLIC_STATUS_TIMEOUT_MS` (700 ms), then gives:

| Pid or port | Status | Public state |
|---|---|---|
| ESRCH | — | exited |
| a WSL Console whose port refuses a connection | — | unreachable |
| alive | 503 `console_starting` | starting |
| alive | refused, and the pid started after the lock was written | replaced |
| alive | refused | stopping |
| alive | any other answer | ready |
| alive | timeout or no answer | unresponsive |

Which states the list shows is its own policy: it hides starting, exited, unreachable, and replaced, and lists ready, stopping, and unresponsive with that state on each entry (`state`, an additive field a reader without it takes as ready). Nothing listed is dropped, because Desktop admits a navigation to a local Console only when the same list names it: a slow Console stays listed and openable, marked only as slow to answer, and a stopping one stays visible so a Console stuck while stopping can be noticed, shown as stopping and not selectable. The list's screen reads that state and nothing else — no probe or timer of its own.

### Stop ladder

An actor that asks a Console to stop:

1. Observes it. If it is stopping, releasing, or exited, it does not request again.
2. Proves its identity: an unreaped own child handle, a parent link (POSIX), or an authenticated health answer with the same pid — plus the process start time when health was the proof.
3. Sends SIGTERM once — unless its request already reached the Console another way (`request: "delivered"`, the update worker below); `request: "none"` is an actor that only waits.
4. Waits, on a monotonic deadline, until the pid exits or the same lock instance is released, up to B_ext.
5. If it saw the release, it sends nothing more and reads the exit record once the process is gone.
6. Past B_ext with the lock still held, it proves identity again: an own child or a parent link, or — while the same lock instance is still held — an unchanged start time or a fresh health answer (`reproveConsoleInstance`; a lock that cannot be read proves nothing). Without proof it signals nothing.
7. SIGKILL, then confirm the exit within `KILL_CONFIRM_MS`; the result is `forced-external`.

An actor that sees an instance someone else is stopping never signals it. B_ext bounds how long it may wait: a starter waits, and reports the instance when it is still stopping after B_ext; Desktop Quit has nothing to do after the wait and returns at once. A starter that gives up on its own child applies the ladder too once that child holds the lock — it may be writing durable state — and gives a child that has not taken the lock only `PRELOCK_CHILD_GRACE_MS` before SIGKILL; its unreaped child handle is its identity proof. On Windows `process.kill(pid, "SIGTERM")` terminates the process outright, so an actor never signals an instance that is already stopping there; it waits up to B_ext.

### Update worker

An accepted in-place update stops the Console that accepted it: the Console stops itself (S1), and a detached worker installs the release and starts the next Console. The worker judges the old and the new Console with the same contract, never a copy of its own:

- **수락 전 준비.** host의 package-manager 검사는 조기 거절일 뿐이다. 실제 worker가 복사본의 sha256/revision, 자신의 환경에서 `root -g`, 설치 경로의 포함 관계와 쓰기 권한까지 확인한 뒤에만 host가 `202 accepted`를 쓴다. worker가 `ready`를 보내기 전에는 Console을 정지하지 않는다.
- **양방향 인계.** spawn이 만든 익명 parent-child IPC fd만 `prepare → ready → commit → committed`를 운반한다. 메시지는 handshake version, 실행별 무작위 `runId`, 현재 단계가 맞아야 유효하다. `runId`나 progress 파일 자체는 권한 증명이 아니며, HTTP나 파일로 commit을 받지 않는다. host가 이번 실행의 `starting`을 기록한 뒤 `prepare`를 보내므로 초기 기록이 worker의 결론을 덮지 않는다. HTTP 응답의 `finish` 뒤에만 host가 commit을 보내며 worker의 확인 뒤 같은 shutdown으로 self-stop한다. worker는 계약 observer로 실제 stopping/releasing/exited/replaced를 본 뒤에만 stop ladder에 들어간다. IPC 전달만 끝나고 host가 계속 응답한다면 정지나 설치를 대신 강행하지 않는다.
- **준비·인계의 상한.** `UPDATE_WORKER_PREFLIGHT_MS`(15 s)는 worker의 준비를, `UPDATE_WORKER_COMMIT_MS`(5 s)는 ready 이후 commit과 commit 확인 이후 실제 정지 관측을 각각 제한한다. host도 같은 상수로 기다린다. 다운로드 및 기존 host의 조기 검사는 이 예산 밖이다. commit 이전 timeout, 응답 쓰기 실패, finish 이전 연결 종료, host 소실에 따른 IPC 단절은 terminal failure다. worker는 신호·설치·복구 serve 없이 종료하며, host는 자신의 아직 수거하지 않은 worker에 한해 `UPDATE_WORKER_ABORT_MS` 뒤 종료를 강제한다(POSIX에서는 그 detached 그룹까지). host는 worker가 끝나기 전에는 다음 실행을 받지 않는다. commit 이후의 외부 crash까지 복귀를 보장하는 것은 아니다.
- **수락 전 실패 DTO.** host는 `503 {error:"update_worker_unavailable", progress}`로 `state/phase:"failed"`, `startedAt`, `fromVersion`, `targetVersion`, 계약의 `reason`, `failureStage:"preflight"|"handoff"`, `description`을 보낸다. `description`은 host의 `describeConsoleUpdateFailure` 결과이며 worker 원문이나 경로를 이 DTO에 싣지 않는다. GET progress와 apply 응답은 같은 실행의 `startedAt`과 결론을 사용한다. 파일은 원자적으로 교체하며, 기록 실패 시 살아 있는 host는 같은 결과를 메모리에서 제공한다(디스크가 계속 고장 난 상태에서 프로세스를 넘어 보존할 수 있다는 뜻은 아니다). 화면은 이를 즉시 실패로 표시하며 재연결 커튼이나 85 s 침묵 안내를 기다리지 않는다.
- **추가 실패 사유와 호환성.** `preflight-failed`는 준비 불가, `preflight-timeout`은 준비 예산 소진, `handoff-aborted`는 인계 미완료다. `failureStage`가 있는 runtime mismatch는 Console 정지를 요청하지 않았다고 설명하고, 이 필드가 없는 구 worker 기록의 해석은 유지한다. host가 외부에서 죽었을 수도 있으므로 미인계 문구는 Console이 지금 살아 있다고 단정하지 않는다. 이 필드와 사유는 additive이며 health의 `CONSOLE_LIFECYCLE_WIRE`는 1이다. worker runtime의 새 정지 관측 export는 `CONSOLE_LIFECYCLE_CONTRACT_VERSION` 2로 식별한다. 구 worker는 작성 당시의 계약을 계속 따른다.

- **Its runtime.** The build emits the worker's lifecycle runtime as one self-contained file (`dist/lifecycle-worker-runtime.mjs` beside the Console bundle, with `CONSOLE_LIFECYCLE_CONTRACT_VERSION`). When the Console accepts an update, while its installed package is still intact and before anything stops, it copies that file beside the worker (`fleet-console-update-<stamp>.lifecycle.mjs`, mode 0600) and writes the sha256 of the copied bytes and the revision into the worker's configuration. The worker imports the copy only when both match, and uses that copy to the end, so files the install replaces never change what it runs.
- **Stopping the old Console.** Its stop request is already delivered, so it sends no SIGTERM (on Windows that would terminate a Console cleaning up). It follows the stop ladder with `request: "delivered"` and installs only once the old process is gone: a Console that released its lock is waited for up to B_ext while it reaps its children, and if it is still running then, nothing is installed (no file it loaded is replaced under it) and nothing is signalled. One still holding its lock after B_ext is SIGKILLed only when its identity is proven again — the parent link (POSIX), an unchanged start time, or a fresh health answer — and the worker records `forced-external`; without proof it signals nothing and the update fails as unverified. A `replaced` lock whose instance is still in place stops the update before the install, reported with `describeReplacedLockAuthor`; once that lock is released the old Console is gone and the update goes on.
- **Starting a Console.** It starts a `serve` only when the lock is gone or its pid is ESRCH, both for the new release and for recovering after a failed install; a lock whose pid still runs (the old Console, or another program that reused its pid) or that cannot be read is reported instead. After a stop that ended still-running, recovery may therefore start a `serve` of the old release while the old process, which already released its lock, is still reaping its children: the two run side by side for a moment, which the contract allows, since the slot belongs to whoever holds the lock.
- **Result.** How the old Console ended (its exit record, or the reading of none) is carried on the update's progress record as `oldConsoleOutcome`. A failure also carries the contract's `reason` (`ConsoleUpdateFailureReason`, `protocol/lifecycle/update.ts`), and every worker-written record carries the worker's pid: a Console that reads a running record whose worker is ESRCH reports `worker-lost` at once. The Console serves the reason with `describeConsoleUpdateFailure`, and a screen states the ending with `describeConsoleUpdateOldConsoleEnding`; neither names a path, and a screen adds no reading of its own.
- **The waiting screen.** The page that accepted the update cannot read the worker's conclusion while no Console answers, and the install has no budget. So it never declares a failure on its own: once the Console has been silent for `UPDATE_FAILED_CONSOLE_RETURN_MS` since it stopped answering (the old Console's stop conclusion plus `CONSOLE_START_TIMEOUT_MS`, by which an update that failed before its install has brought a Console back), it shows `describeConsoleUpdateSilence`, `describeConsoleUpdateRecovery`, and `fleet console start` beside the curtain and keeps polling. Lock paths stay out of the browser; that command prints them with the shared lock texts.

| Runtime copy | What happens |
|---|---|
| ① the bundle is missing or unreadable (a damaged install) | the update is refused before the worker exists (`503 update_worker_unavailable`); the Console keeps running |
| ② the copy's sha256 or revision differs from the configuration | worker가 준비 단계에서 `lifecycle-runtime-mismatch`를 기록하고 종료한다. host는 typed 503으로 거절하며, Console을 내리지 않고 worker도 신호·설치·복구 serve를 실행하지 않는다 |
| ③ the new release is installed while the worker runs | the worker keeps judging with its copy, which is what the old release shipped; lock and health change only additively, so it reads the new Console correctly |
| ④ the Console it meets reports a newer `lifecycleWire` | unverified for signals and removal; success is a health answer at the target version from a pid other than the old one |
| ⑤ the worker was written by a Console from before this contract | that worker runs its own old judgment; it neither knows nor needs the runtime |
| ⑥ a downgrade to a release before this contract | the worker (current runtime) judges a wire-0 Console by the legacy reading; a missing exit record reads `unrecorded` |

## Children

A Console's children must not outlive it on any exit path (I2).

### Owned process groups

- Every agent CLI the Console's SDK users start — Agent chat, Analyst, and the AI Gateway's routing model — goes through one spawn port (`ConsoleRuntimeContext.spawnAgentProcess`), and so does the Computer Use codex app-server. On POSIX each starts as the leader of a **process group of its own** and is registered in the Console's owned-process registry (`createOwnedProcessRegistry`); its MCP servers and tool processes stay in that group. The port is required where those children are composed, so none of them can be started without it.
- A child the Console hands off on purpose is never registered and never signalled by the Console: the detached update worker (and the Console it starts), PTY sessions (their terminal ends them), and the file explorer's open and reveal actions (`open`, `xdg-open`, `explorer`), which start the user's own application.
- A plugin asks for a child the Console must end with it through the plugin host capability `ctx.host.processes.spawnOwned(request)` (the Ledger plugin's tokscale CLI, the Skills plugin's CLI and its npm bootstrap, and the Repository plugin's `git fetch`, `push`, and `pull`, and the commands that write its worktree back (`git restore`, `git stash push -u`, `apply`, `pop`), whose smudge filters such as git-lfs may download: commands that can wait on the network). That child leads its own group in the same registry, tagged `plugin:<id>` with the id the host binds, and the deadline and the reaper reach it like an agent CLI. The returned handle's `killGroup` ends the child together with everything it started (a timeout ending git's `git-remote-https`, `ssh`, or filter process with it), under the registry's proof rule: only while the child itself is unreaped (E1); after that it signals nothing, and a helper left behind by a plugin's own timeout is ended by the next stop's step below, the deadline, or the reaper. The capability is additive and optional (a plugin falls back when an older Console lacks it) and only spawns: a plugin cannot register a pid it started itself, list the Console's groups, end them all, or signal anything but its own child through the returned handle, and a child meant to outlive the Console must not use it. On Windows it is a plain child, so the Windows note below applies to it unchanged.
- A plugin child started without the port stays in the Console's own group and is not part of the stop step for registered plugin groups below (nothing proves it without a process table): the deadline's fallback sweep below ends it, with outcome `deadline`, but after a crash or an external SIGKILL nothing does, and it runs until it ends by itself. That is accepted only for bounded local work that ends on its own: the file explorer's ripgrep searches (cancelled with their request, and ended by a broken pipe once they print), clipboard writes (stdin closed, 5 s timeout), and tree `git` calls (5 s timeout), and the Repository plugin's other `git` commands, which are local and run no hooks: every command of it that could run one (commit, stash, fetch, push, pull) sets `core.hooksPath` to the null device, and it runs no merge, rebase, checkout, switch, or worktree add.
- On a normal stop the SDK closes each agent CLI (stdin close, SIGTERM to the leader after 2 s, SIGKILL after 5 more, about 7 s in all).
- On macOS and Linux, the plugins' registered groups have no such owner, so right after the plugins' own cleanup callbacks the single cleanup sends each of them SIGTERM and, `OWNED_GROUP_TERM_GRACE_MS` later, SIGKILL (follow-up e7874487:N9). Before this, one plugin child waiting on the network kept the Console alive past its released lock until the deadline, and a normal stop was reported as `deadline`.
  - SIGTERM, and SIGKILL to a group whose leader is still the Console's unreaped child, are proved by E1 alone, with no process table.
  - When the grace ends, a group whose leader has exited but which still has members — the common CLI shape where the CLI ends on SIGTERM and a helper that ignored it keeps its inherited pipes, and so the Console, alive — is SIGKILLed only if one process-table read (`PROCESS_TABLE_TIMEOUT_MS`) proves it by the member window, as the deadline and the reaper do. This is the only process-table read on this path, taken once for all such groups and only when there is one. It is asynchronous, since these leaders are already reaped and nothing can be reaped between the read and the signal. Without a readable table nothing is signalled and the deadline covers it. A group whose leader had already exited before the stop, leaving a helper behind, is judged the same way and gets SIGKILL with no SIGTERM: nothing is left there to be graceful to.
  - Agent groups are not included (an early SIGTERM would cut the CLI's own flush on stdin's end), nor the Computer Use codex app-server, which its own dispose ends.
  - The grace does not hold the lock: the lock is released at the end of the cleanup as before, and the remaining plugin groups end during *releasing*, like agent CLIs. Both run in parallel, so a normal stop takes about 7 s at worst, about 3 s inside B_int, and ends `clean` once every child is gone.
  - On Windows no group is registered, so this step ends nothing, as before. Windows stops from outside (the CLI, Desktop) terminate the process with no cleanup at all, and libuv's job object ends its direct children. The one gap is a self-stop such as an in-place update while a plugin child hangs: it ends at the deadline, and no child is orphaned. It belongs to the Windows residual risk below.
- When the stop deadline fires, the Console reads the process table **at most once**, when the first step below needs it, and both steps judge by that one snapshot; so the deadline adds at most one `PROCESS_TABLE_TIMEOUT_MS` to B_int, which is the delay B_ext is sized for. It first SIGKILLs the registered groups:
  - A group whose leader is still the Console's **unreaped child** is signalled as a whole without reading the process table: an unreaped child's pid, and so its group number, cannot be reused (E1). This is the common case — an agent CLI that ignored SIGTERM — and it needs no `ps`, so a process table that cannot be read in time no longer leaves orphans (follow-up e7874487:N8).
  - A group whose leader already exited but which still has members is signalled only when a `ps` snapshot proves them: no process holds the leader's pid, and every member started between the group's spawn (less the 2 s start-time margin) and now. If the table cannot be read within `PROCESS_TABLE_TIMEOUT_MS`, that group is left alone (I1 before I2); the reaper below gets a second chance once the Console is gone.
  - Never the Console's own group (a Desktop sidecar shares Desktop's) and never a group number ≤ 1.
- Then, as a fallback, it SIGKILLs every **unregistered** descendant that still shares the Console's own process group (a plugin's tool, a git or ripgrep call, a stdio MCP transport that hung), deepest first, from that same snapshot. The only judgment is "same group as the Console": a child that leads a group of its own is either registered (already handled above) or handed off on purpose, and is never signalled here. Without a readable table this step signals nothing; the registered groups led by unreaped children were already ended without it.
- Windows has no process groups and the reaper sends no signal there. A direct child started without `detached` is ended with the Console by libuv's job object. Its own children are ended too only when that child is itself libuv-based (Node) and did not detach them: measured once on a Windows runner (U2, run https://github.com/sbluemin/fleet-harness/actions/runs/37276822282, Node 22.23.3), terminating the "Console" process gave:

  | Child | Grandchild | Child afterwards | Grandchild afterwards |
  |---|---|---|---|
  | Node, not detached | Node, not detached | ended | ended |
  | Node, not detached | Node, detached | ended | **survives** |
  | Node, detached | Node, not detached | **survives** | **survives** |
  | Node, detached | Node, detached | **survives** | **survives** |
  | PowerShell (not libuv) | `Start-Process` | ended | **survives** |

  So on Windows an agent CLI that is not libuv-based (or that detaches its MCP servers or tools) leaves those grandchildren behind when the Console crashes or is killed. This is a recorded Windows residual risk, outside this contract's POSIX containment.
- **The reaper** covers every exit path the Console cannot run code on — a crash, an external SIGKILL, a frozen loop killed from outside. The real Claude Code CLI (2.1.289) does not exit on stdin EOF while a turn is open and survives its parent's SIGKILL together with its MCP children (measured, U1), so a watcher outside the Console is required:
  - **Lifecycle.** Only the lock owner starts one, synchronously when it publishes the lock and before it starts any owned child (a lock loser starts none). It is a Node helper (`console-reaper.mjs` beside the Console bundle) in a session of its own, with the Console holding the write end of its stdin; it is not one of the Console's groups and never keeps the Console's event loop alive. The Console tells it about each group as it is registered, its leader exits, or it empties. A reaper that ends while its Console runs is replaced once and told everything again; a second loss is recorded as `reaper_degraded` and containment falls back to the Console's own deadline.
  - **Trigger.** The pipe's end (the Console's death closes it). The Console's children do not inherit the reaper's socket (it is created close-on-exec, and every child the Console starts goes through an exec), so on every supported path the pipe ends with the Console. The 5 s check that the Console's pid still runs is only a backstop should the write end ever leak.
  - **Drain.** It writes `external` if the instance left no exit record, then ends every registered group it can prove from a `ps` snapshot: a group whose leader still runs only when the leader's start time matches the registration (± 2 s); a group whose leader exited by the member window above. Each proof judges every group by one snapshot. The first proof reads the table at most twice (a second chance for a Console whose own deadline could not read it, 300 ms apart); the proof right before SIGKILL reads it once. Without a readable table a proof proves nothing. It sends SIGTERM, waits up to `OWNED_GROUP_TERM_GRACE_MS` (2 s), proves again, and sends SIGKILL to what remains; it never signals its own group, a group number ≤ 1, or anything it cannot prove (I1), and sends nothing at all on Windows.
  - **Lifetime.** It exits when the drain ends and at the latest `REAPER_DRAIN_MAX_MS` after the Console is gone, so it never becomes an orphan itself. That cap is the sum of every step, all table reads included: up to 1 s for the Console's pid to go, the first proof's two reads and their 300 ms pause (2.3 s), the 2 s grace, the last proof's one read (1 s), the 3 s kill confirmation, and a 1 s margin — 10.3 s. A SIGTERM while its Console runs makes it exit without touching anything (the Console replaces it); SIGINT and SIGHUP are ignored.
  - **Crash.** An uncaught exception while *ready* still exits at once (outcome `crash`); the reaper then gives the agent CLIs SIGTERM, which lets the real CLI flush and exit, and SIGKILL after 2 s.

Because the Console spawns agent CLIs itself, the SDK no longer reads their stderr: the spawn adapter drains it (and forwards it to an SDK `stderr` callback when one is set) and delivers the exit once stderr has closed, as the SDK's own spawner does. The SDK's exit errors no longer end with a `stderr:` tail; instead the Console writes the last 2 KB of a CLI that exits with a non-zero code or an unexpected signal to its failure log (`agent_cli_exit` in `errors.jsonl`). The SDK's default debug file is not passed either; it only applies when SDK debugging is enabled.

### Console-owned temporary files

Launch prompt files and Quick Launch attachments live in temporary namespaces a Console owns. Each namespace is keyed by a hash of the **real path** of what it belongs to (the lock file for launch prompts, the data directory for attachments), so every spelling of one slot shares it. An entry's name carries its creator's pid. Only the lock owner reclaims leftovers, right after taking the lock, and only entries whose creator is ESRCH (or that an earlier process with this same pid left); an entry of a Console that is still running stays even when lock exclusivity was broken (follow-up f64f5d65). On shutdown a Console removes its own entries and removes the namespace root only when it is empty. Quick Launch attachments left by a Console from before this contract — entries without a creator pid, and a namespace keyed by a data-directory spelling that is not its real path — are never reclaimed; after an upgrade they stay under TMPDIR until the OS clears it.

## Rationale and history

The chain of lifecycle fixes #1527–#1565 each patched one actor's own copy of lock reading, identity proof, signalling, and a 10 s budget. The copies drifted: a refused endpoint meant "stopping" to one actor and "absent" to another, the external SIGKILL and the internal deadline were both 10 s and raced, an update's self-stop bypassed the shutdown that signals used, and a stop that the deadline ended was reported to the CLI as a clean stop. This contract puts each judgment in one place and lets actors choose only policy.
