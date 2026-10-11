import { useEffect, useState, type MouseEvent } from "react";

import { mongleStateOf, type MongleState } from "@fleet-console/sdk/avatars";
import type { TheaterContribution, TheaterContributionContext, TheaterMenuContext } from "@fleet-console/sdk/plugin";

import {
  isRunningObjective,
  isWaitingObjective,
  loadCommodore,
  noteCommodoreLanguage,
  readCommodore,
  readCommodoreExperiment,
  setCommodoreAutonomy,
  COMMODORE_INBOX_SECTION_ID,
  setCommodorePeek,
  subscribeCommodore,
  useCommodore,
} from "./commodore-state.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { isCommodoreConversationActive } from "./commodore-conversation.js";
import { getT } from "./i18n/index.js";
import { readTheater, subscribeObjective, useObjectiveTheater } from "./objectives-state.js";
import type { Objective } from "../server/types.js";

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** 그 Theater 의 자율 운영이 켜져 있는가 — 아직 설정을 읽지 않았으면 꺼짐이다. 입출력 없음. */
function autonomyOn(theaterId: string): boolean {
  return readCommodoreExperiment().enabled && readCommodore(theaterId).view?.state.autonomy === true;
}

function subscribeCommodoreFace(listener: () => void): () => void {
  const offCommodore = subscribeCommodore(listener);
  const offObjectives = subscribeObjective(listener);
  return () => { offCommodore(); offObjectives(); };
}

/**
 * 사이드바 Theater 머리에 사령관이 빌려 주는 것 — 이니셜 칩 자리의 사령관 글리프, 턴을 도는 동안의 이름 물결, 머리를 누르면 여는
 * Inbox 칸, 우클릭 메뉴의 「자율 운영 켜기/끄기」. Console 설정을 읽기 전에는 이니셜 칩을 그대로 둔다.
 */
export const commodoreTheaterContribution: TheaterContribution = {
  id: "commodore",
  mark: (context) => (readCommodoreExperiment().enabled ? <CommodoreHeaderMark {...context} /> : null),
  header: {
    // 얼굴은 사령관 상태와 그 Theater 목표 보드를 함께 읽는다 — 어느 쪽이 바뀌어도 머리가 다시 읽는다.
    subscribe: subscribeCommodoreFace,
    // 사이드바 밖에서 그 Theater 의 사령관 아바타를 그리는 표면(Quick Launch 칩·팔레트 행)이 머리 표식과 같은 얼굴을 읽는다.
    face: (theaterId) => {
      if (!readCommodoreExperiment().enabled) return null;
      const view = readCommodore(theaterId).view;
      // 꺼짐은 머리 표식이 회색을 정하는 조건(commodoreSummary 의 on 이 아님)과 같다.
      return { state: commodoreMongleState(view, readTheater(theaterId).objectives), off: view?.state.autonomy !== true };
    },
    live: (theaterId) => autonomyOn(theaterId) && readCommodore(theaterId).view?.run.phase === "turn",
    // 대화 중심 화면은 자율 운영 여부와 무관하게 가운데 사령관 대화를 연다. 기존 배치의 첫 칸은 그대로 유지한다.
    landing: (theaterId) => (isCommodoreConversationActive() || autonomyOn(theaterId) ? { sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" } : null),
  },
  menu: (context) => (readCommodoreExperiment().enabled ? <CommodoreAutonomyMenuItem {...context} /> : null),
};

/**
 * 머리의 사령관 표식 — 그 Theater 사령관의 몽글 아바타(베이스 + brass 별 배지)다. 한 번 누르면 해당 Theater 의 자율 운영을 켜고 끈다.
 * 켜진 Theater 는 제 색, 꺼진 Theater 는 흐린 회색이다. 얼굴과 몸짓이 지금을 말한다: 오류·재시도면 어지러운 얼굴과 땀방울,
 * 턴을 도는 동안 몽글(이름 물결은 호스트가 함께 흘린다), 사령관이 운영하는 목표가 사람을 기다리면 부름 고리, 그 밖에는 가만히.
 * 머무는(또는 키보드로 들어온) 동안 사이드바에서 사령관의 목표 표식이 함께 밝아지고, 툴팁이 상태 문장을 말한다.
 */
function CommodoreHeaderMark({ theater, language }: TheaterContributionContext) {
  const t = getT(language);
  const { view } = useCommodore(theater.id);
  const board = useObjectiveTheater(theater.id);
  const [busy, setBusy] = useState(false);
  // 언어를 먼저 알린다 — 첫 읽기부터 서버가 사람의 언어를 기억한다.
  noteCommodoreLanguage(language);
  // 아직 읽지 않았거나 읽어 둔 상태가 비워졌으면(플러그인 재설치 등) 다시 읽는다 — 활성이 아닌 Theater 는 이 표식만 읽는다.
  const loaded = view !== null && view !== undefined;
  useEffect(() => { if (!loaded) void loadCommodore(theater.id); }, [theater.id, loaded]);
  // 표식이 사라지면(Theater 잊기 등) 밝힘을 거둔다.
  useEffect(() => () => setCommodorePeek(null), [theater.id]);
  const peek = (inside: boolean) => () => setCommodorePeek(inside ? theater.id : null);
  const { on, meta, patrol, errorReason } = commodoreSummary(t, view, board.objectives);
  const warn = on && (view?.run.phase === "error" || view?.run.phase === "retrying");
  const status = [`${t("objectives.commodore.name")} · ${meta.map((part) => part.text).join(" · ")}`, patrol, errorReason].filter(Boolean).join("\n");
  const state = commodoreMongleState(view, board.objectives);
  // 꺼짐 회색은 다른 표면의 Theater 아바타와 같은 규칙이다 — `header.face` 의 off 와 같은 조건(자율 운영 꺼짐)이다.
  const glyph = <CommodoreAvatar theaterId={theater.id} state={state} size={18} label={t("objectives.commodore.name")} decorative off={!on} className="objectives-commodore-mark-glyph" />;
  const toggleAutonomy = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (busy || !view) return;
    setBusy(true);
    void setCommodoreAutonomy(theater.id, !on).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      className={`objectives-commodore-mark ${on ? "is-on" : "is-off"}${warn ? " is-warn" : ""}`}
      aria-label={t(on ? "objectives.commodore.mark.onAria" : "objectives.commodore.mark.offAria", { theater: theater.label })}
      aria-pressed={on}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      disabled={!view}
      title={[status, t(on ? "objectives.commodore.mark.onTitle" : "objectives.commodore.mark.offTitle")].join("\n")}
      onClick={toggleAutonomy}
      onMouseEnter={peek(true)}
      onMouseLeave={peek(false)}
      onFocus={peek(true)}
      onBlur={peek(false)}
    >
      {glyph}
    </button>
  );
}

/** 우클릭(Shift+F10) 메뉴의 한 줄 — 머리 글리프와 같은 자율 운영 켜기/끄기. */
function CommodoreAutonomyMenuItem({ theater, language, onClose }: TheaterMenuContext) {
  const t = getT(language);
  const { view } = useCommodore(theater.id);
  noteCommodoreLanguage(language);
  useEffect(() => { void loadCommodore(theater.id); }, [theater.id]);
  const on = view?.state.autonomy === true;
  return (
    <button
      type="button"
      role="menuitem"
      className="theater-menu-item objectives-commodore-menu-item"
      disabled={!view}
      onClick={() => {
        onClose();
        void setCommodoreAutonomy(theater.id, !on).catch(() => undefined);
      }}
    >
      <span className={`theater-menu-check objectives-commodore-menu-glyph${on ? " is-on" : ""}`} aria-hidden="true"><CommodoreMentionGlyph className="objectives-commodore-menu-glyph-svg" /></span>
      <span className="theater-menu-label">{on ? t("objectives.commodore.menu.turnOff") : t("objectives.commodore.menu.turnOn")}</span>
    </button>
  );
}

type CommodoreView = ReturnType<typeof useCommodore>["view"];

/**
 * 사령관의 지금 얼굴 — 사이드바 머리 표식과 대화 중심 화면(머리 pill·오른쪽 패널 머리)이 같은 사실로 고른다. 자율 운영이 꺼져 있으면
 * 쉼이고, 실패·재시도는 오류 얼굴(얼굴 기준 `mongleStateOf` 에 없는 사령관 몫)이다. 그 밖에는 턴을 도는 동안 작업 중, 사령관이 운영하는
 * 목표가 사람을 기다리면 대기, 아니면 쉼이다.
 */
export function commodoreMongleState(view: CommodoreView, objectives: readonly Objective[]): MongleState {
  if (view?.state.autonomy !== true) return "idle";
  if (view.run.phase === "error" || view.run.phase === "retrying") return "error";
  const waiting = objectives.some((objective) => objective.operator === "commodore" && isWaitingObjective(objective));
  return mongleStateOf({ activity: view.run.phase === "turn" ? "running" : waiting ? "awaiting" : "idle" });
}
export type CommodoreMetaPart = { readonly key: string; readonly text: string; readonly tone?: "on" | "warn" };

/**
 * 사령관의 지금을 말하는 짧은 조각들 — 사이드바 머리 표식의 툴팁과 모바일 바로가기·화면이 같은 말을 쓴다.
 * 켜져 있으면 자율·응답 중·재시도·오류·진행·처리, 꺼져 있으면 수동·대기. 다음 순찰과 오류 사유는 따로 돌려준다.
 */
export function commodoreSummary(t: ReturnType<typeof getT>, view: CommodoreView, objectives: readonly Objective[]): { readonly on: boolean; readonly meta: readonly CommodoreMetaPart[]; readonly patrol: string | null; readonly errorReason: string | null } {
  const on = view?.state.autonomy === true;
  const run = view?.run;
  const running = objectives.filter(isRunningObjective).length;
  // 대기는 사령관이 운영하는 목표만 센다 — 사람의 목표는 사령관을 깨우지 않는다(서버 판정 `operator`).
  const waiting = objectives.filter((objective) => objective.operator === "commodore" && isWaitingObjective(objective)).length;
  const meta: CommodoreMetaPart[] = on
    ? [
      { key: "mode", text: t("objectives.commodore.meta.autonomous"), tone: "on" },
      ...(run?.phase === "turn" ? [{ key: "turn", text: t("objectives.commodore.meta.turn") }] : []),
      ...(run?.phase === "retrying" && run.nextWakeAt ? [{ key: "retry", text: t("objectives.commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }), tone: "warn" as const }] : []),
      ...(run?.phase === "error" ? [{ key: "error", text: t("objectives.commodore.meta.error"), tone: "warn" as const }] : []),
      { key: "running", text: t("objectives.commodore.meta.running", { n: running }) },
      { key: "handled", text: t("objectives.commodore.meta.handled", { n: run?.totals.actions ?? 0 }) },
    ]
    : [
      { key: "mode", text: t("objectives.commodore.meta.manual") },
      { key: "waiting", text: t("objectives.commodore.meta.waiting", { n: waiting }) },
    ];
  const patrol = on && run?.phase === "idle" && run.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null;
  const errorReason = on && (run?.phase === "error" || run?.phase === "retrying") ? run.reason ?? null : null;
  return { on, meta, patrol, errorReason };
}
