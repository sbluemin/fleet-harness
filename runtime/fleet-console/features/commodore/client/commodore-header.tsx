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
import { getT } from "./i18n/index.js";
import { isRunningObjective, isCommodoreWaiting, readTheater, subscribeObjective, useObjectiveTheater } from "./board.js";
import type { CommodoreBoardObjective as Objective } from "../../objectives/shared/commodore-board-client.js";

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function subscribeCommodoreFace(listener: () => void): () => void {
  const offCommodore = subscribeCommodore(listener);
  const offObjectives = subscribeObjective(listener);
  const offConversation = subscribeCommodoreConversationActive(listener);
  return () => { offCommodore(); offObjectives(); offConversation(); };
}

/**
 * 사이드바 Theater 머리에 사령관이 빌려 주는 것 — 이니셜 칩 자리의 사령관 글리프, 턴을 도는 동안의 이름 물결, 머리를 누르면 여는
 * Inbox 칸. 순찰 설정과 무관하게 활성 얼굴이며, 표식을 누르면 사령관 대화를 연다.
 */
export const commodoreTheaterContribution: TheaterContribution = {
  id: "commodore",
  mark: (context) => (readCommodoreExperiment().enabled ? <CommodoreHeaderMark {...context} /> : null),
  header: {
    // 얼굴은 사령관 상태와 그 Theater 목표 보드를 함께 읽는다 — 어느 쪽이 바뀌어도 머리가 다시 읽는다.
    subscribe: subscribeCommodoreFace,
    // 사이드바 밖에서 그 Theater 의 사령관 아바타를 그리는 표면(새 세션 칩·팔레트 행)이 머리 표식과 같은 얼굴을 읽는다.
    face: (theaterId) => {
      if (!readCommodoreExperiment().enabled) return null;
      const view = readCommodore(theaterId).view;
      return { state: commodoreMongleState(view, readTheater(theaterId).objectives), off: false };
    },
    selected: isCommodoreConversationSelected,
    live: (theaterId) => readCommodore(theaterId).view?.run.phase === "turn",
    landing: () => ({ sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" }),
  },
};

/**
 * 머리의 사령관 표식 — 순찰과 무관하게 제 색인 몽글 아바타다. 누르면 사령관 대화를 연다.
 * 얼굴과 몸짓이 지금을 말한다: 오류·재시도면 어지러운 얼굴과 땀방울,
 * 턴을 도는 동안 몽글(이름 물결은 호스트가 함께 흘린다), 사령관이 운영하는 목표가 사람을 기다리면 부름 고리, 그 밖에는 가만히.
 * 머무는(또는 키보드로 들어온) 동안 사이드바에서 사령관의 목표 표식이 함께 밝아지고, 툴팁이 상태 문장을 말한다.
 */
function CommodoreHeaderMark({ theater, language, theaterInbox }: TheaterContributionContext) {
  const t = getT(language);
  const { view } = useCommodore(theater.id);
  const board = useObjectiveTheater(theater.id);
  // 언어를 먼저 알린다 — 첫 읽기부터 서버가 사람의 언어를 기억한다.
  noteCommodoreLanguage(language);
  // 아직 읽지 않았거나 읽어 둔 상태가 비워졌으면(플러그인 재설치 등) 다시 읽는다 — 활성이 아닌 Theater 는 이 표식만 읽는다.
  const loaded = view !== null && view !== undefined;
  useEffect(() => { if (!loaded) void loadCommodore(theater.id); }, [theater.id, loaded]);
  // 표식이 사라지면(Theater 잊기 등) 밝힘을 거둔다.
  useEffect(() => () => setCommodorePeek(null), [theater.id]);
  const peek = (inside: boolean) => () => setCommodorePeek(inside ? theater.id : null);
  const { meta, patrol, errorReason } = commodoreSummary(t, view, board.objectives);
  const warn = (view?.run.phase === "error" || view?.run.phase === "retrying");
  const name = useCommodoreName(theater.id, t);
  const status = [`${name} · ${meta.map((part) => part.text).join(" · ")}`, patrol, errorReason].filter(Boolean).join("\n");
  const state = commodoreMongleState(view, board.objectives);
  const glyph = <CommodoreAvatar theaterId={theater.id} state={state} size={18} label={name} decorative className="objectives-commodore-mark-glyph" />;
  // 사령관이 사람에게 물어 답을 기다리는 질문 수 — 레일 배지·「내 결정」과 같은 판정(`openAsks`)이다. 자율 운영이 꺼져 있어도 선다(답은 받는다).
  const asks = openAsks(theater.id).length;
  const asksWord = asks > 0 ? t("commodore.board.ask.badge", { count: asks }) : null;
  return (
    <button
      type="button"
      className={`objectives-commodore-mark${warn ? " is-warn" : ""}`}
      aria-label={[t("commodore.mark.open", { theater: theater.label }), asksWord].filter(Boolean).join(", ")}
      title={[theater.label, status, asksWord, t("commodore.mark.open", { theater: theater.label })].filter(Boolean).join("\n")}
      onClick={(event) => { event.stopPropagation(); if (!openCommodoreConversation(theater.id)) theaterInbox?.open({ theaterId: theater.id, sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" }); }}
      onMouseEnter={peek(true)}
      onMouseLeave={peek(false)}
      onFocus={peek(true)}
      onBlur={peek(false)}
    >
      {glyph}
      {asks > 0 ? <span className="objectives-commodore-mark-badge" aria-hidden="true">{asks}</span> : null}
    </button>
  );
}

type CommodoreView = ReturnType<typeof useCommodore>["view"];

/**
 * 사령관의 지금 얼굴 — 사이드바 머리 표식과 대화 중심 화면(머리 pill·오른쪽 패널 머리)이 같은 사실로 고른다. 순찰과 무관하게
 * 메시지 턴도 작업 중이며, 실패·재시도는 오류 얼굴(얼굴 기준 `mongleStateOf` 에 없는 사령관 몫)이다. 그 밖에는 턴을 도는 동안 작업 중, 사령관이 운영하는
 * 목표가 사람을 기다리면 대기, 아니면 쉼이다.
 */
export function commodoreMongleState(view: CommodoreView, objectives: readonly Objective[]): MongleState {
  if (!view) return "idle";
  if (view.run.phase === "error" || view.run.phase === "retrying") return "error";
  const waiting = view.active && objectives.some((objective) => isCommodoreWaiting(objective));
  return mongleStateOf({ activity: view.run.phase === "turn" ? "running" : waiting ? "awaiting" : "idle" });
}
export type CommodoreMetaPart = { readonly key: string; readonly text: string; readonly tone?: "on" | "warn" };

/**
 * 사령관의 지금을 말하는 짧은 조각들 — 사이드바 머리 표식의 툴팁과 모바일 바로가기·화면이 같은 말을 쓴다.
 * 자동 운영 여부와 지금 턴의 진행·오류를 구분한다. 다음 순찰과 오류 사유는 따로 돌려준다.
 */
export function commodoreSummary(t: ReturnType<typeof getT>, view: CommodoreView, objectives: readonly Objective[]): { readonly on: boolean; readonly meta: readonly CommodoreMetaPart[]; readonly patrol: string | null; readonly errorReason: string | null } {
  const on = view?.active === true;
  const run = view?.run;
  const running = objectives.filter(isRunningObjective).length;
  // 대기는 사령관이 운영하는 목표의, 사람에게 넘기지 않은 항목만 센다 — 사람의 목표는 사령관을 깨우지 않는다(서버 판정 `operator`).
  const waiting = objectives.filter((objective) => isCommodoreWaiting(objective)).length;
  const meta: CommodoreMetaPart[] = [
    { key: "mode", text: t(on ? "commodore.meta.autonomous" : "commodore.meta.patrolOff"), ...(on ? { tone: "on" as const } : {}) },
    ...(run?.phase === "turn" ? [{ key: "turn", text: t("commodore.meta.turn") }] : []),
    ...(run?.phase === "retrying" && run.nextWakeAt ? [{ key: "retry", text: t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }), tone: "warn" as const }] : []),
    ...(run?.phase === "error" ? [{ key: "error", text: t("commodore.meta.error"), tone: "warn" as const }] : []),
    ...(on ? [
      { key: "running", text: t("commodore.meta.running", { n: running }) },
      { key: "handled", text: t("commodore.meta.handled", { n: run?.totals.actions ?? 0 }) },
    ] : [{ key: "waiting", text: t("commodore.meta.waiting", { n: waiting }) }]),
  ];
  const patrol = on && run?.phase === "idle" && run.nextWakeAt ? t("commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null;
  const errorReason = (run?.phase === "error" || run?.phase === "retrying") ? run.reason ?? null : null;
  return { on, meta, patrol, errorReason };
}
