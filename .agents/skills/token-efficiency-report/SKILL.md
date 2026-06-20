---
name: token-efficiency-report
description: 현재 세션의 캐리어 오케스트레이션 실사용량을 실측 집계하고, 제독 단독 수행 가정 대비 In/Output 토큰·컨텍스트 윈도우 절감 효과를 정량 보고하는 스킬입니다.
---

# Token Efficiency Report

Use this skill to produce a quantitative token-efficiency report for a Fleet operation: measure the Admiral session's actual Claude Code usage, collect per-carrier usage from each engine's own session logs, compute the coordination overhead, and model the counterfactual cost of the Admiral doing the same work solo (subagents included). The entire skill is read-only — it never modifies any file.

## Inputs

Replace each `<placeholder>` before running.

- `<admiral-session-jsonl>` — Optional. Absolute path to the Admiral session transcript under `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`. Default: the current session's transcript (the harness exposes the path in context; otherwise identify it by matching `carrier_dispatch` records against the operation being measured — never by mtime alone).
- `<operation-window>` — Optional. Start/end timestamps bounding the operation. Default: derive it — start = first `carrier_dispatch` timestamp in the transcript, end = last operation commit time (`git log`) or last carrier result, whichever is later.
- `<worktree-path>` — Optional. The operation's git checkout used to measure deliverable size. Default: the current working directory.
- `<base-ref>` — Optional. Git ref the deliverable diff is measured against (e.g., `origin/canary`). Default: the repository's main integration branch.

## Goal

Report, with verifiable evidence: (1) measured token consumption split between the Admiral plane (Claude Code) and the carrier plane (per engine), (2) the orchestration coordination overhead in tokens, (3) a clearly-labeled counterfactual estimate of solo execution, and (4) the resulting savings percentages and context-window preservation. Estimates must never be presented as measurements.

## Required Workflow

### 1. Environment and scope

1. Run `pwd`, confirm the OS/shell, and read the repository root `AGENTS.md` (and any subdirectory `AGENTS.md` later touched).
2. Resolve `<admiral-session-jsonl>`, `<worktree-path>`, `<base-ref>`.

### 2. Admiral plane measurement

1. Sum the Admiral transcript usage:
   ```sh
   jq -s '[.[] | select(.message.usage) | .message.usage] |
     {turns: length,
      input: ([.[].input_tokens]|add),
      output: ([.[].output_tokens]|add),
      cache_read: ([.[].cache_read_input_tokens // 0]|add),
      cache_creation: ([.[].cache_creation_input_tokens // 0]|add)}' <admiral-session-jsonl>
   ```
2. Record "new input" = `input + cache_creation` (tokens newly loaded into context) separately from `cache_read` (total reprocessed volume).
3. Count compaction events: `grep -c '"isCompactSummary":true'`.
4. Record the final context occupancy from the **last** usage record (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`).

### 3. Dispatch ledger and operation window

1. Extract every `carrier_dispatch` call with timestamp and carrier id:
   ```sh
   jq -r 'select(.message.content[]?.type=="tool_use" and (.message.content[]?.name | tostring | test("carrier_dispatch"))) |
     .timestamp + " " + ([.message.content[] | select(.type=="tool_use" and (.name|tostring|test("carrier_dispatch"))) | .input.carrier_id // "?"] | join(","))' <admiral-session-jsonl>
   ```
2. Derive `<operation-window>` per Inputs. Cross-check the end bound with `git -C <worktree-path> log <base-ref>..HEAD --format='%h %ci %s'`.
3. **Timezone trap**: transcript timestamps are UTC; Codex rollout filenames and directory dates are local time. Normalize before matching.

### 4. Carrier plane measurement (per engine)

Map each dispatched carrier to its engine via `~/.fleet/carriers.json` (`agentCliType`, plus `taskforce` members where present). Note that the file reflects the *current* configuration — if a session found below contradicts it (e.g., a rollout exists for an opencode-configured carrier), trust the logs and flag the mapping as inferred.

- **Codex** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`):
  - Filter by `session_meta` `payload.cwd` (the main checkout or the worktree both count — fleet may spawn carriers from either) AND session start inside the window. Resumed sessions may carry later waves without producing new rollout files.
  - Usage = the **last** `token_count` event's cumulative figure:
    ```sh
    grep '"token_count"' <rollout> | tail -1 | jq '.payload.info.total_token_usage // .payload.total_token_usage'
    ```
  - Uncached input = `input_tokens - cached_input_tokens`.
- **Claude Code and Claude-compatible engines** (e.g., kimi variants) (`~/.claude/projects/<dir-for-cwd>/*.jsonl`): find files whose first event falls in the window (check both the main-checkout project dir and the worktree project dir), then sum usage with the same jq as step 2.1.
- **OpenCode** (`~/.local/share/opencode/storage/`): include only if records exist inside the window.

### 5. Session attribution audit (mandatory)

Concurrent user sessions contaminate the sample. For every candidate carrier session:

1. Inspect the first real user prompt (skip `local-command-caveat` lines). A carrier job opens with a dispatch-format prompt or an injected `AGENTS.md` preamble; a human session opens with free-form text or slash commands unrelated to the dispatch ledger.
2. Match the session start time against a dispatch timestamp (a few seconds' skew is normal). Check the `message.model` field against the carrier's configured model as corroborating evidence.
3. Exclude unmatched sessions and list each exclusion with its reason in the report.
4. Sessions that cannot be confidently attributed either way are excluded from totals and reported as `[unattributed]` with their usage shown separately.

### 6. Coordination overhead

From the Admiral transcript, measure the full round-trip cost of delegation:

- Dispatch payload size: total characters of all `carrier_dispatch` tool_use inputs.
- Result payload size: total characters of user-type messages containing `carrier:result`.
- Convert to tokens at ~3 chars/token for Korean-English mixed text, and report the ratio of coordination tokens to total carrier-plane processing volume.

### 7. Deliverable size

`git -C <worktree-path> diff <base-ref>...HEAD --shortstat` plus commit count, review rounds, and any other scope markers from the operation record.

### 8. Counterfactual model (label every figure as estimate)

Model: the carrier plane's work is transferred 1:1 onto the Admiral's Claude usage at equal output quality.

- Solo Output ≈ Admiral output + carrier-plane output total.
- Solo new Input ≈ Admiral new input + carrier-plane uncached input total.
- Solo total processing ≈ Admiral total + carrier-plane total input (treat as a **lower bound** — a solo context grows monotonically, so cache_read scales super-linearly).
- Context window: divide solo new input by the active context window size to estimate the compaction count; contrast with the measured compaction count and final occupancy.
- State the subagent caveat: subagents isolate the main context but still bill every token to the same Claude account, so In/Output savings from subagents alone are ≈ 0; the orchestration savings come from offloading volume to non-Anthropic engines plus context isolation.

### 9. Report in Korean

Produce the final report with:

1. 실측 표 — 평면(제독/캐리어 엔진별) × {신규 Input, Output, 총 Input 처리량}, 산출물 규모 한 줄.
2. 조율 오버헤드 — 디스패치/결과 왕복 토큰과 캐리어 처리량 대비 비율.
3. 반사실 표 — 단독 추정 vs 실측 vs 절감률(%), compact 횟수·종료 시 컨텍스트 점유 비교.
4. 증거 리스트 — `[verified]`/`[deferred]`/`[unresolved]` 형식으로 데이터 소스와 매핑 근거 명시.
5. 한계 고지 — 반사실은 추정 모델임, 세션 귀속의 추정 부분, 품질 차원(다관점 리뷰 재현 불가)은 비교에서 고정됨.

## Safety Rules

- Strictly read-only: never write, edit, or delete any file, and never run state-changing git commands.
- Never present counterfactual figures without an explicit estimate label; measured and modeled numbers must stay visually separated.
- Never include a session in carrier totals without passing the attribution audit; silent inclusion of a human session invalidates the report.
- Never compare timestamps across sources without timezone normalization.
- Cross-check every jq aggregate once (recompute or spot-check by hand) before reporting.
- If carrier-side logs for an engine are missing, report the gap explicitly instead of extrapolating.

## Carrier Delegation Guidance

- Run the measurement directly as the Admiral by default — local log aggregation is cheaper than a sortie (Proportionality).
- **Vanguard** — optional, only when log discovery spans unfamiliar engine storage layouts and a focused reconnaissance sweep is genuinely faster.
- **Stop and report** — if session attribution stays ambiguous after the audit, surface the ambiguity to the Admiral of the Navy rather than guessing.
