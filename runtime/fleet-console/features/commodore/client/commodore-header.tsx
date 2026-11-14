import { useCommodoreName } from "./commodore-name.js";
import { useEffect } from "react";

import { mongleStateOf, type MongleState } from "../../workspace/shared/avatars.js";
import type { TheaterContribution, TheaterContributionContext } from "../../workspace/shared/surface-contracts.js";

import {
  loadCommodore,
  noteCommodoreLanguage,
  openAsks,
  readCommodore,
  readCommodoreExperiment,
  COMMODORE_INBOX_SECTION_ID,
  setCommodorePeek,
  subscribeCommodore,
  useCommodore,
} from "./commodore-state.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { openCommodoreConversation, isCommodoreConversationSelected, subscribeCommodoreConversationActive } from "./commodore-conversation.js";
import { subscribe as subscribeConsole } from "../../../core/client/src/integration/store.js";
import { subscribeConversationSubject } from "../../workspace/client/conversation/conversation-slots.js";
import { subscribeConversationSurface } from "../../workspace/client/conversation/conversation-surface-store.js";
import { getT } from "./i18n/index.js";
import { isRunningObjective, isCommodoreWaiting, subscribeObjective, useObjectiveTheater } from "./board.js";
import type { CommodoreBoardObjective as Objective } from "../../objectives/shared/commodore-board-client.js";

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function subscribeCommodoreFace(listener: () => void): () => void {
  const offCommodore = subscribeCommodore(listener);
  const offObjectives = subscribeObjective(listener);
  const offConversation = subscribeCommodoreConversationActive(listener);
  const offConsole = subscribeConsole(listener);
  const offSubject = subscribeConversationSubject(listener);
  const offSurface = subscribeConversationSurface(listener);
  return () => { offCommodore(); offObjectives(); offConversation(); offConsole(); offSubject(); offSurface(); };
}

/**
 * 사이드바 Theater 머리에 사령관이 빌려 주는 것 — 이니셜 칩 자리의 사령관 글리프, 턴을 도는 동안의 이름 물결, 머리를 누르면 여는
 * Inbox 칸. 루틴 설정과 무관하게 활성 얼굴이며, 표식을 누르면 사령관 대화를 연다.
 */
export const commodoreTheaterContribution: TheaterContribution = {
  id: "commodore",
  mark: (context) => (readCommodoreExperiment().enabled ? <CommodoreHeaderMark {...context} /> : null),
  header: {
    // 얼굴은 사령관 상태와 그 Theater 목표 보드를 함께 읽는다 — 어느 쪽이 바뀌어도 머리가 다시 읽는다.
    subscribe: subscribeCommodoreFace,
    selected: isCommodoreConversationSelected,
    // 사이드바 머리의 id 는 사령관 UUID 다(사령관 줄) — 그 사령관을 그대로 읽는다.
    live: (commodoreId) => readCommodore(commodoreId).view?.run.phase === "turn",
    landing: () => ({ sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" }),
  },
};

/**
 * 머리의 사령관 표식 — 루틴과 무관하게 제 색인 몽글 아바타다. 누르면 사령관 대화를 연다.
 * 얼굴과 몸짓이 지금을 말한다: 오류·재시도면 어지러운 얼굴과 땀방울,
 * 턴을 도는 동안 몽글(이름 물결은 호스트가 함께 흘린다), 사령관이 운영하는 목표가 사람을 기다리면 부름 고리, 그 밖에는 가만히.
 * 머무는(또는 키보드로 들어온) 동안 사이드바에서 사령관의 목표 표식이 함께 밝아지고, 툴팁이 상태 문장을 말한다.
 */
function CommodoreHeaderMark({ theater, language, theaterInbox, boardPersonDecisionCount = 0 }: TheaterContributionContext) {
  const t = getT(language);
  // 사이드바 머리는 사령관 줄이다 — 머리의 id 가 곧 사령관 UUID 다.
  const commodoreId = theater.id;
  const { view } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  noteCommodoreLanguage(language);
  const loaded = view !== null && view !== undefined;
  useEffect(() => { if (commodoreId && !loaded) void loadCommodore(commodoreId); }, [commodoreId, loaded]);
  // 표식이 사라지면(Theater 잊기 등) 밝힘을 거둔다.
  useEffect(() => () => setCommodorePeek(null), [theater.id]);
  const peek = (inside: boolean) => () => setCommodorePeek(inside ? theater.id : null);
  const { meta, routine, errorReason } = commodoreSummary(t, view, board.objectives);
  const warn = (view?.run.phase === "error" || view?.run.phase === "retrying");
  const name = useCommodoreName(commodoreId, t);
  const status = [`${name} · ${meta.map((part) => part.text).join(" · ")}`, routine, errorReason].filter(Boolean).join("\n");
  // 사람에게 넘긴 기준·검토·후속 — 펼친 목록의 줄과 같은 묶음 판정을 호스트가 `boardPersonDecisionCount` 로
  // 넘긴다. 채팅을 열어 보고 답 없이 떠나도 머리의 아바타 상태·숫자가 유지된다. 사령관이 직접 묻는
  // 질문(`asks`)도 같은 사람 차례라 얼굴은 함께, 숫자는 합산한다.
  const asks = openAsks(commodoreId).length;
  const personDecision = asks > 0 || boardPersonDecisionCount > 0;
  const state = commodoreMongleState(view, board.objectives, personDecision);
  const glyph = <CommodoreAvatar commodoreId={commodoreId} state={state} size={18} label={name} decorative className="objectives-commodore-mark-glyph" figure />;
  // 숫자 배지 — 사령관 질문과 넘긴 항목을 합산한다. 답·철회로 걷히면 같은 판정이 함께 0이 되어 사라진다.
  const total = asks + boardPersonDecisionCount;
  const asksWord = asks > 0 ? t("commodore.board.ask.badge", { count: asks }) : null;
  const boardWord = boardPersonDecisionCount > 0 ? t("commodore.personHolds", { n: boardPersonDecisionCount }) : null;
  const decisionWords = [asksWord, boardWord].filter((part) => part !== null).join(", ");
  return (
    <button
      type="button"
      className={`objectives-commodore-mark${warn ? " is-warn" : ""}`}
      aria-label={[t("commodore.mark.open", { theater: theater.label }), decisionWords || null].filter((part) => part !== null && part !== "").join(", ")}
      title={[theater.label, status, decisionWords || null, t("commodore.mark.open", { theater: theater.label })].filter((part) => part !== null && part !== "").join("\n")}
      onClick={(event) => { event.stopPropagation(); if (!commodoreId || !openCommodoreConversation(commodoreId)) theaterInbox?.open({ theaterId: theater.id, sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" }); }}
      onMouseEnter={peek(true)}
      onMouseLeave={peek(false)}
      onFocus={peek(true)}
      onBlur={peek(false)}
    >
      {glyph}
      {total > 0 ? <span className="objectives-commodore-mark-badge" aria-hidden="true">{total}</span> : null}
    </button>
  );
}

type CommodoreView = ReturnType<typeof useCommodore>["view"];

/**
 * 사령관의 지금 얼굴 — 사이드바 머리 표식과 대화 중심 화면(머리 pill·오른쪽 패널 머리)이 같은 사실로 고른다. 루틴과 무관하게
 * 메시지 턴도 작업 중이며, 실패·재시도는 오류 얼굴(얼굴 기준 `mongleStateOf` 에 없는 사령관 몫)이다. 그 밖에는 턴을 도는 동안 작업 중, 사람이 답할
 * 차례인 질문·넘긴 항목이 남아 있으면 결정, 사령관이 운영하는 목표가 사람을 기다리면 대기, 아니면 쉼이다. 결정은 열람으로
 * 지워지지 않고 답·철회로만 걷힌다.
 */
export function commodoreMongleState(view: CommodoreView, objectives: readonly Objective[], personDecision = false): MongleState {
  if (!view) return "idle";
  if (view.run.phase === "error" || view.run.phase === "retrying") return "error";
  const waiting = view.active && objectives.some((objective) => isCommodoreWaiting(objective));
  return mongleStateOf({ activity: view.run.phase === "turn" ? "running" : waiting ? "awaiting" : "idle", personTurn: personDecision });
}
export type CommodoreMetaPart = { readonly key: string; readonly text: string; readonly tone?: "on" | "warn" };

/**
 * 사령관의 지금을 말하는 짧은 조각들 — 사이드바 머리 표식의 툴팁과 모바일 바로가기·화면이 같은 말을 쓴다.
 * 자동 운영 여부와 지금 턴의 진행·오류를 구분한다. 다음 루틴과 오류 사유는 따로 돌려준다.
 */
export function commodoreSummary(t: ReturnType<typeof getT>, view: CommodoreView, objectives: readonly Objective[]): { readonly on: boolean; readonly meta: readonly CommodoreMetaPart[]; readonly routine: string | null; readonly errorReason: string | null } {
  const on = view?.active === true;
  const run = view?.run;
  const running = objectives.filter(isRunningObjective).length;
  // 대기는 사람에게 넘기지 않은 항목만 센다.
  const waiting = objectives.filter((objective) => isCommodoreWaiting(objective)).length;
  const meta: CommodoreMetaPart[] = [
    { key: "mode", text: t(on ? "commodore.meta.autonomous" : "commodore.meta.inactive"), ...(on ? { tone: "on" as const } : {}) },
    ...(run?.phase === "turn" ? [{ key: "turn", text: t("commodore.meta.turn") }] : []),
    ...(run?.phase === "retrying" && run.nextWakeAt ? [{ key: "retry", text: t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }), tone: "warn" as const }] : []),
    ...(run?.phase === "error" ? [{ key: "error", text: t("commodore.meta.error"), tone: "warn" as const }] : []),
    ...(on ? [
      { key: "running", text: t("commodore.meta.running", { n: running }) },
      { key: "handled", text: t("commodore.meta.handled", { n: run?.totals.actions ?? 0 }) },
    ] : [{ key: "waiting", text: t("commodore.meta.waiting", { n: waiting }) }]),
  ];
  const routine = nextRoutineWord(t, view);
  const errorReason = (run?.phase === "error" || run?.phase === "retrying") ? run.reason ?? null : null;
  return { on, meta, routine, errorReason };
}

/** 다음 루틴은 감독자의 시각을 쓴다. 브라우저가 다른 시간대여도 등록한 지역 일정과 같다. */
export function nextRoutineWord(t: ReturnType<typeof getT>, view: CommodoreView): string | null {
  if (!view?.active || view.run.phase !== "idle") return null;
  const times = view.run.routineNextRuns ?? {};
  const routine = (view.state.routines ?? []).filter((r) => r.enabled && times[r.id] !== undefined).sort((a, b) => times[a.id]! - times[b.id]!)[0];
  if (!routine) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: view.run.routineTimeZone }).format(times[routine.id]!);
  return t("commodore.drawer.nextRoutine", { name: routine.name, time });
}
