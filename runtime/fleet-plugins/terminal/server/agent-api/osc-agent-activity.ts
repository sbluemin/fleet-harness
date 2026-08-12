import type { AgentCliId } from "@dotobokuri/fleet-admiral";

import type { AgentModelActivity } from "./types.js";

export type OscAgentActivityClassification = AgentModelActivity | "unknown";

export interface OscAgentActivityTracker {
  observeTitle(title: string): void;
  reset(): void;
}

interface OscAgentActivityTrackerOptions {
  readonly cliId: AgentCliId;
  readonly cwdBasename: string;
  readonly onActivity: (activity: AgentModelActivity) => void;
}

const NOT_WORKING_STABILITY_MS = 400;
const CLAUDE_NOT_WORKING = 0x2733;
// 작업 중 스피너 글리프 알파벳. CLI 버전마다 프레임 문자가 바뀌므로 계열 단위로 인식하고, 옛 세션이
// 끊기지 않게 계열을 여러 개 동시에 인식한다: 브라유 점자(구버전)와 원형 4프레임 ◐◑◒◓
// (2026-08-12 Claude Code v2.1.228 실측). 이 축은 "무언가 작업 중"까지만 말한다 — 그 작업이 호스트
// 턴인지 턴보다 오래 남은 백그라운드 작업인지는 턴 경계가 가르며, 그 판정은 클라이언트 활동 해석이 한다.
// 화이트리스트를 유지하는 이유는 doctrine이다 — 모르는 타이틀은 무의견으로 남아야 어휘가 또 드리프트해도
// 거짓 idle이 아니라 hook 폴백으로 퇴보한다.
const WORKING_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2800, 0x28ff],
  [0x25d0, 0x25d3],
];

export function classifyOscAgentActivity(
  cliId: AgentCliId,
  title: string,
): OscAgentActivityClassification {
  const first = title.codePointAt(0);
  if (first === undefined) return "unknown";
  if (WORKING_CODEPOINT_RANGES.some(([start, end]) => first >= start && first <= end)) return "working";
  return first === CLAUDE_NOT_WORKING ? "not-working" : "unknown";
}

export function createOscAgentActivityTracker(options: OscAgentActivityTrackerOptions): OscAgentActivityTracker {
  let committed: AgentModelActivity | undefined;
  let pendingNotWorking: ReturnType<typeof setTimeout> | undefined;

  function observeTitle(title: string): void {
    const classification = classifyOscAgentActivity(options.cliId, title);
    if (classification === "unknown") return;
    if (classification === "working") {
      cancelPendingNotWorking();
      committed = "working";
      options.onActivity("working");
      return;
    }
    if (committed === "not-working" || pendingNotWorking) return;
    pendingNotWorking = setTimeout(() => {
      pendingNotWorking = undefined;
      commit("not-working");
    }, NOT_WORKING_STABILITY_MS);
  }

  function commit(activity: AgentModelActivity): void {
    if (committed === activity) return;
    committed = activity;
    options.onActivity(activity);
  }

  function cancelPendingNotWorking(): void {
    if (!pendingNotWorking) return;
    clearTimeout(pendingNotWorking);
    pendingNotWorking = undefined;
  }

  function reset(): void {
    cancelPendingNotWorking();
    committed = undefined;
  }

  return { observeTitle, reset };
}
