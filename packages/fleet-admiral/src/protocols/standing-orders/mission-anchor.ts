/**
 * standing-orders/mission-anchor — Mission Anchor Standing Order
 *
 * 모든 checkpoint 판단을 Mission Objective에 정렬시키는 범프로토콜 기준점.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const MISSION_ANCHOR: StandingOrder = {
  id: "mission-anchor",
  name: "Mission Anchor",
  prompt: String.raw`## Mission Anchor Standing Order

All checkpoint decisions are governed by the Mission Objective: the single outcome the user's request requires.

### Trigger
Apply this Standing Order before entering the active protocol's first operational checkpoint and at every active protocol checkpoint boundary in any multi-checkpoint task.

### Procedure
1. **Anchor Statement** — Before the active protocol begins, derive the objective from the user's request and state it once, verbatim for the rest of the operation, in this exact form:
   ${"``"}Objective: [single sentence]${"``"}
2. **Anchor Recall** — Before entering each active protocol checkpoint, output exactly one short line:
   ${"``"}Anchor recall — Objective: "<verbatim>" | This checkpoint serves by: <1 line>${"``"}
3. **Post-Checkpoint Self-Check** — After each checkpoint, output exactly one short alignment line:
   ${"``"}Aligned? [yes / partial — adjust / drift — halt]${"``"}
4. **Drift Recovery** — If the self-check is ${"``"}partial — adjust${"``"} or ${"``"}drift — halt${"``"}, do not enter the next checkpoint. Return to the original user request, re-derive the anchor, and continue only after the objective is clear.
5. **Compact Mode** — For trivial single-checkpoint tasks with no more than 3 changed lines, state the Objective once and omit per-checkpoint Anchor Recall lines. Multi-checkpoint tasks never use this exemption.`,
};
