import type { MongleActivity } from "@fleet-console/sdk/avatars";

/**
 * 사령관이 턴 중에 지금 하는 일 — 아바타가 연기하는 활동(`MongleActivity`)으로 접는다. 감독자가 `run` 사건의 `step` 으로 실어
 * 보내므로 기록을 열지 않은 표면(사이드바 머리 등)도 받는다. 라이브 글자·도구 사건(`op:"live"`)은 기록을 연 Theater 에만 남는다.
 *
 * Chat 세션의 계열 보고와 같은 규칙이다: 생각 중에는 사건이 없으므로 도구도 글자도 흐르지 않는 공백이 1초를 넘으면 생각으로 보고,
 * 프레임을 늘리지 않게 값이 바뀔 때만 최소 간격을 두고 마지막 값 하나만 보낸다. 표시 쪽이 한 활동에 최소 시간 머무르므로 그보다
 * 짧게 스친 값은 보내지 않아도 화면이 잃는 것이 없다.
 */

export const COMMODORE_STEP_THINK_AFTER_MS = 1_000;
export const COMMODORE_STEP_MIN_INTERVAL_MS = 500;

/** 이름으로 정해지는 사령관 도구. 사령관에게는 셸·파일 편집 도구가 없다 — 지시·정보를 고쳐 쓰는 일이 편집이다. */
const TOOL_STEPS: Readonly<Record<string, MongleActivity>> = {
  read_file: "read",
  git_log: "read",
  issue_list: "read",
  asks: "read",
  intel: "edit",
  directive: "edit",
  ask_person: "text",
  withdraw_ask: "text",
  next_wake: "think",
  WebSearch: "fetch",
  WebFetch: "fetch",
};

/**
 * 도구 하나의 활동. 보드 도구는 쓰기 action 이면 목표를 움직이는 일(위임), 그 밖은 보드 읽기다. MCP 접두사가 붙은 그 밖의 도구
 * (브라우저 등)는 바깥에서 가져오는 일이다. 모르는 도구는 null — 기본 리듬으로 움직인다.
 */
export function commodoreStepOfTool(name: string, action: string | undefined, boardWrites: ReadonlyMap<string, ReadonlySet<string>>): MongleActivity | null {
  const writes = boardWrites.get(name);
  if (writes) return action && writes.has(action) ? "delegate" : "read";
  return TOOL_STEPS[name] ?? null;
}

export interface CommodoreStepReporter {
  /** 턴이 열렸다 — 첫 출력 전의 공백도 생각이다. */
  turnOpened(): void;
  /** 글자가 흘렀다. */
  text(): void;
  /** 사고 블록이 흘렀다. */
  thinking(): void;
  /** 도구가 시작했다(`id` 가 없으면 끝을 알 수 없어 다음 사건까지 그 도구의 것이다). */
  toolStarted(id: string | undefined, step: MongleActivity | null): void;
  /** 도구가 끝났다. 도는 도구가 남지 않으면 공백을 잰다. */
  toolEnded(id: string | undefined): void;
  /** 대화를 요약했다. */
  compacted(): void;
  /** 턴이 닫혔다 — 활동을 지운다. */
  turnClosed(): void;
  dispose(): void;
}

export function createCommodoreStepReporter(report: (step: MongleActivity | null) => void, now: () => number = Date.now): CommodoreStepReporter {
  const inFlight = new Map<string, MongleActivity | null>();
  let open = false;
  let desired: MongleActivity | null = null;
  let sent: MongleActivity | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let thinkTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearThink = () => { if (thinkTimer !== null) clearTimeout(thinkTimer); thinkTimer = null; };
  const clearFlush = () => { if (flushTimer !== null) clearTimeout(flushTimer); flushTimer = null; };
  const flush = () => {
    flushTimer = null;
    if (!open || desired === sent) return;
    sent = desired;
    sentAt = now();
    report(sent);
  };
  const want = (step: MongleActivity | null) => {
    desired = step;
    if (desired === sent) { clearFlush(); return; }
    if (flushTimer !== null) return;
    const wait = sentAt + COMMODORE_STEP_MIN_INTERVAL_MS - now();
    if (wait <= 0) flush();
    else flushTimer = setTimeout(flush, wait);
  };
  /** 도는 도구가 없으면 1초 뒤 생각으로 넘어간다 — 그 사이 다른 사건이 오면 취소된다. */
  const armThink = () => {
    clearThink();
    if (!open || inFlight.size > 0) return;
    thinkTimer = setTimeout(() => { thinkTimer = null; if (open && inFlight.size === 0) want("think"); }, COMMODORE_STEP_THINK_AFTER_MS);
  };
  const flowing = (step: MongleActivity) => {
    if (!open) return;
    want(step);
    armThink();
  };

  return {
    turnOpened() {
      open = true;
      inFlight.clear();
      want("think");
    },
    text() { flowing("text"); },
    thinking() { flowing("think"); },
    toolStarted(id, step) {
      if (!open) return;
      clearThink();
      if (id) inFlight.set(id, step);
      want(step);
    },
    toolEnded(id) {
      if (!open) return;
      if (id) inFlight.delete(id);
      // 여러 도구가 함께 돌면 남은 도구의 것이다.
      const remaining = [...inFlight.values()].at(-1);
      if (remaining !== undefined) want(remaining);
      armThink();
    },
    compacted() { flowing("compact"); },
    turnClosed() {
      open = false;
      inFlight.clear();
      clearThink();
      clearFlush();
      desired = null;
      if (sent !== null) { sent = null; sentAt = now(); report(null); }
    },
    dispose() {
      open = false;
      clearThink();
      clearFlush();
    },
  };
}
