import { React } from "@fleet-console/sdk/plugin/browser";

import { getT, type TerminalMessageKey } from "../i18n/index.js";
import { clearSessionGoal, setSessionGoal } from "./goal-api.js";
import { GoalSheet } from "./goal-sheet.js";
import { applySessionUpdate, getAgentState } from "./store.js";
import type { GoalState, SessionGoal, SessionInfo } from "./types.js";
import "./goal.css";

const GOAL_STATE_KEYS = {
  requested: "terminal.goal.state.requested",
  active: "terminal.goal.state.active",
  deferred: "terminal.goal.state.deferred",
  met: "terminal.goal.state.met",
  impossible: "terminal.goal.state.impossible",
  capped: "terminal.goal.state.capped",
  unknown: "terminal.goal.state.unknown",
} as const satisfies Record<GoalState, TerminalMessageKey>;

const TERMINAL_STATES: ReadonlySet<GoalState> = new Set(["met", "impossible"]);
const LEDGER_STATES: ReadonlySet<GoalState> = new Set(["active", "deferred", "capped"]);
const ARMED_STATES: ReadonlySet<GoalState> = new Set(["requested", "active", "deferred"]);
// 눈금은 한 줄 안에서 고정폭을 차지한다. 이보다 큰 한도에서는 눈금을 잘라 보여 주는 대신
// 숫자만 남긴다 — 잘린 눈금은 한도를 잘못 말하고, 눈금의 존재 이유는 정직한 이산 표시다.
const LEDGER_MAX_TICKS = 12;

export interface GoalStripProps {
  readonly session: SessionInfo;
  readonly language?: "en" | "ko";
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}

export function GoalStrip({ session, language = "en", expanded, onToggleExpanded }: GoalStripProps) {
  const t = getT(language);
  const goal = session.goal;
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<TerminalMessageKey | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  // 접힌 본문은 화면에서 사라져도 포커스 순서에는 남는다. 높이만 0으로 만드는 애니메이션은
  // 그 사실을 바꾸지 않으므로 inert로 직접 떼어낸다.
  React.useEffect(() => {
    const element = bodyRef.current;
    if (element) (element as HTMLDivElement & { inert: boolean }).inert = !expanded;
  }, [expanded]);

  // 세션이 죽었는데 sentinel 마커를 한 번도 못 봤다면(=requested) 목표는 무장된 적이 없다.
  // Claude의 --resume은 마지막 goal_status에서 복원하므로 되살릴 것도 없고, 재개 경고를 붙이면 거짓이다.
  const neverArmed = goal !== undefined && !goal.live && goal.state === "requested";
  const lastSeenActive = goal !== undefined && !goal.live && !TERMINAL_STATES.has(goal.state) && !neverArmed;
  const stateText = goal === undefined
    ? t("terminal.goal.empty")
    : t(lastSeenActive
      ? "terminal.goal.state.lastSeen"
      : neverArmed ? "terminal.goal.state.unknown" : GOAL_STATE_KEYS[goal.state]);
  const summary = goal === undefined ? null : completionSummary(goal, language);
  const headerMeta = goal === undefined
    ? null
    : goal.live && LEDGER_STATES.has(goal.state)
      ? t("terminal.goal.checks", { used: goal.checksUsed, limit: goal.checkLimit })
      : summary;
  const hintKey = goal === undefined
    ? null
    : lastSeenActive
      ? "terminal.goal.resumeWarning"
      : neverArmed ? "terminal.goal.unknownHint" : goalHintKey(goal.state);
  const pendingLimitText = goal?.pendingCheckLimit === undefined
    ? null
    : t("terminal.goal.pendingLimit", { limit: goal.pendingCheckLimit });
  const goalCondition = goal === undefined
    ? null
    : goal.origin === "fleet" && goal.condition
      ? goal.condition
      : t("terminal.goal.terminalOrigin");
  const caveat = hintKey ? t(hintKey) : null;
  // 늘고 주는 칸은 하나뿐이므로 무엇을 앞세울지 상태가 정한다. 강제 중에는 "무엇을 시켰나"가,
  // 끝난 뒤에는 "이 판정을 어디까지 믿을 수 있나"가 사용자의 다음 행동을 바꾼다.
  // 밀려난 쪽은 title로 남긴다 — 줄이는 것이지 지우는 것이 아니다.
  const detail = [caveat ?? goalCondition, pendingLimitText].filter(Boolean).join(" · ") || null;
  const detailFull = [caveat, goalCondition, pendingLimitText].filter(Boolean).join(" · ") || null;

  // 목표가 끝났거나(met/impossible) 세션이 죽었으면 "치우기", 아직 강제 중이면 "해제".
  // 둘은 같은 DELETE 호출이고 라벨만 다르다 — 서버는 세션이 죽어 있어도 기록을 지워 준다.
  const live = goal?.live ?? true;
  const ended = goal !== undefined && TERMINAL_STATES.has(goal.state);
  const showClear = goal !== undefined && live && !ended;
  const showDismiss = goal !== undefined && (!live || ended);
  // 목표가 없으면 펼침 자체가 "목표를 거는 중"이다 — 빈 영수증을 먼저 보여 줄 이유가 없다.
  const showSheet = goal === undefined || sheetOpen;
  // 강제 중인 목표만 박동한다 — 끝났거나 세션이 죽은 목표는 더 이상 진행 중이 아니다.
  const armed = goal !== undefined && goal.live && ARMED_STATES.has(goal.state);
  const showSet = !showSheet && goal !== undefined && live && !showClear;

  const submit = async (condition: string, checkLimit: number) => {
    setBusy(true);
    setError(null);
    try {
      const nextGoal = await setSessionGoal(session.sessionId, condition, checkLimit);
      applyGoalUpdate(session, nextGoal);
      setSheetOpen(false);
    } catch (submitError) {
      setError(goalErrorKey(submitError));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearSessionGoal(session.sessionId);
      applyGoalUpdate(session, undefined);
      setSheetOpen(false);
      // 해제 직후 설정 시트를 들이밀지 않는다 — 줄을 접어 두면 머리글이 "설정된 목표 없음"으로
      // 남아, 새 목표는 그 줄을 다시 여는 한 번의 클릭이 된다.
      if (expanded) onToggleExpanded();
    } catch (clearError) {
      setError(goalErrorKey(clearError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`terminal-goal-strip${expanded ? " is-open" : ""}${goal === undefined ? " is-empty" : ""}`}>
      <div className="terminal-goal-body" ref={bodyRef}>
        <div className="terminal-goal-body-clip">
          <div className="terminal-goal-body-inner">
            {showSheet ? (
              <GoalSheet
                session={session}
                language={language}
                busy={busy}
                error={error}
                onCancel={() => {
                  setError(null);
                  setSheetOpen(false);
                  // 목표가 없는 상태에서 시트를 닫는 것은 곧 이 줄을 접는 것이다.
                  if (goal === undefined) onToggleExpanded();
                }}
                onSubmit={(condition, checkLimit) => { void submit(condition, checkLimit); }}
              />
            ) : (
              /* 한 줄이 예산의 전부다. 고정폭(표식·상태·눈금·조작)이 자리를 잡고, 늘고 주는
                 것은 가운데 한 칸뿐이다 — 그 칸이 무엇을 담을지는 상태가 정한다. */
              <div className="terminal-goal-row">
                <span className="terminal-goal-mark">{t("terminal.goal.mark")}</span>
                <span className="terminal-goal-state">{stateText}</span>
                {goal && LEDGER_STATES.has(goal.state)
                  ? <GoalLedger goal={goal} language={language} />
                  : headerMeta ? <span className="terminal-goal-meta">{headerMeta}</span> : null}
                {error
                  ? <span className="terminal-goal-error" role="alert">{t(error)}</span>
                  : detail
                    ? <span className="terminal-goal-detail" title={detailFull ?? detail}>{detail}</span>
                    : <span className="terminal-goal-detail" />}
                <span className="terminal-goal-actions">
                  {showSet ? (
                    <button type="button" disabled={busy} onClick={() => { setError(null); setSheetOpen(true); }}>
                      {t("terminal.goal.action.set")}
                    </button>
                  ) : null}
                  {showClear ? (
                    <button type="button" disabled={busy} onClick={() => { void clear(); }}>
                      {t("terminal.goal.action.clear")}
                    </button>
                  ) : null}
                  {showDismiss ? (
                    <button type="button" disabled={busy} onClick={() => { void clear(); }}>
                      {t("terminal.goal.action.dismiss")}
                    </button>
                  ) : null}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 서랍 손잡이. 패널 위 가장자리에 붙어 있어 목표 패널이 위로 펼쳐지면 함께 올라오고,
          같은 자리를 다시 누르면 접힌다 — 여는 손잡이와 닫는 손잡이가 하나여야 한다.
          가로 중앙에 두는 이유는 레일 손잡이(우측)와 명판(우상단)을 모두 비켜서다. */}
      <button
        type="button"
        className="terminal-goal-tab"
        aria-expanded={expanded}
        aria-label={t(expanded ? "terminal.goal.handle.close" : "terminal.goal.handle.open")}
        onClick={onToggleExpanded}
      >
        {armed ? <span className="terminal-goal-pulse" aria-hidden="true" /> : null}
        <span className="terminal-goal-mark">{t("terminal.goal.mark")}</span>
        {/* 펼친 동안에는 바로 아래 줄이 같은 상태를 말한다 — 탭까지 되풀이할 이유가 없다. */}
        {goal === undefined || expanded ? null : <span className="terminal-goal-tab-state">{stateText}</span>}
        <span className="terminal-goal-caret" aria-hidden="true">»</span>
      </button>
    </section>
  );
}

function GoalLedger({ goal, language }: { readonly goal: SessionGoal; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const count = t("terminal.goal.checks", { used: goal.checksUsed, limit: goal.checkLimit });
  return (
    <div className={`terminal-goal-ledger${goal.checksUsed >= goal.checkLimit ? " is-exhausted" : ""}`} role="img" aria-label={count}>
      {goal.checkLimit > LEDGER_MAX_TICKS ? null : Array.from({ length: goal.checkLimit }, (_, index) => {
        const tick = index + 1;
        const className = tick < goal.checksUsed
          ? "terminal-goal-tick is-spent"
          : tick === goal.checksUsed
            ? "terminal-goal-tick is-current"
            : "terminal-goal-tick";
        return <span key={tick} className={className} aria-hidden="true" />;
      })}
      <span className="terminal-goal-count" aria-hidden="true">{count}</span>
    </div>
  );
}

// 있는 조각만 이어 붙인다. durationMs와 tokens는 서로 독립적으로 optional이라, 한쪽이 없을 때
// 0을 채우면 측정하지 않은 값을 측정했다고 보고하는 셈이 된다.
function completionSummary(goal: SessionGoal, language: "en" | "ko"): string | null {
  if (goal.state !== "met" && goal.state !== "impossible") return null;
  const t = getT(language);
  const parts = [t("terminal.goal.summary.checks", { checks: goal.totalChecks ?? goal.checksUsed })];
  if (typeof goal.durationMs === "number" && Number.isFinite(goal.durationMs)) {
    const seconds = Math.round(goal.durationMs / 1000);
    parts.push(seconds < 90
      ? t("terminal.goal.duration.seconds", { seconds })
      : t("terminal.goal.duration.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }));
  }
  if (typeof goal.tokens === "number" && Number.isFinite(goal.tokens)) {
    parts.push(t("terminal.goal.summary.tokens", { tokens: goal.tokens.toLocaleString(language === "ko" ? "ko-KR" : "en-US") }));
  }
  return parts.join(" · ");
}

// 세 줄 예산 안에서 각주 자리는 하나뿐이다. 상태 단어가 이미 말하는 것(진행 중·유예)은
// 빼고, 사용자의 다음 행동을 바꾸는 문장만 남긴다.
function goalHintKey(state: GoalState): TerminalMessageKey | null {
  if (state === "met") return "terminal.goal.metHint";
  if (state === "capped") return "terminal.goal.cappedHint";
  if (state === "unknown") return "terminal.goal.unknownHint";
  return null;
}

function applyGoalUpdate(session: SessionInfo, goal: SessionGoal | undefined): void {
  const latest = getAgentState().sessions[session.sessionId] ?? session;
  applySessionUpdate({ ...latest, goal });
}

function goalErrorKey(error: unknown): TerminalMessageKey {
  const message = error instanceof Error ? error.message : "";
  if (message === "terminal.goal.error.unsupported" || message === "terminal.goal.error.tooLong") return message;
  return "terminal.goal.error.notLive";
}
