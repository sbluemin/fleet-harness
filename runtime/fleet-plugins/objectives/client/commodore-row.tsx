import { useEffect, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";

import type { TheaterContributionContext } from "@fleet-console/sdk/plugin";
import type { ClientTheaterInboxCapability, TheaterInboxSnapshot } from "@fleet-console/sdk/theater-inbox";

import {
  isRunningObjective,
  isWaitingObjective,
  loadCommodore,
  noteCommodoreLanguage,
  setCommodoreAutonomy,
  COMMODORE_INBOX_SECTION_ID,
  setCommodorePeek,
  useCommodore,
  useCommodoreEnabled,
} from "./commodore-state.js";
import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { commodorePreview, openCommodoreConversation, useCommodoreConversation } from "./commodore-conversation.js";
import { getT } from "./i18n/index.js";
import { useObjectiveTheater } from "./objectives-state.js";
import type { Objective } from "../server/types.js";

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 사이드바 Theater 머리 아래의 사령관 줄. 왼쪽 글리프가 자율 운영 스위치(Quick Launch 사령관 멘션과 같은 마크 — brass = 켬, 흐린 회색 = 끔)이고,
 * 줄을 누르면 Theater Inbox 의 「사령관 › 기록」이 열린다. 실험 기능 「자율 운영」이 꺼져 있으면 줄이 없다.
 */
export function CommodoreRow({ theater, language, theaterInbox }: TheaterContributionContext) {
  const enabled = useCommodoreEnabled();
  if (!enabled) return null;
  return <CommodoreRowBody theaterId={theater.id} theaterLabel={theater.label} language={language} inbox={theaterInbox ?? null} />;
}

const NO_INBOX = () => () => undefined;
const CLOSED = (): TheaterInboxSnapshot | null => null;

/** 호스트 Theater Inbox 의 지금 — 없는(옛) 호스트면 늘 닫혀 있다. */
function useInboxSnapshot(inbox: ClientTheaterInboxCapability | null): TheaterInboxSnapshot | null {
  return useSyncExternalStore(inbox?.subscribe ?? NO_INBOX, inbox?.read ?? CLOSED, inbox?.read ?? CLOSED);
}

/** 이 플러그인이 `theaterInboxSections` 에 적은 섹션 id — 줄이 받는 capability 는 플러그인 범위라 이 로컬 id 로 열고 읽는다. */
const COMMODORE_SECTION_ID = COMMODORE_INBOX_SECTION_ID;

function CommodoreRowBody({ theaterId, theaterLabel, language, inbox }: { readonly theaterId: string; readonly theaterLabel: string; readonly language: "en" | "ko"; readonly inbox: ClientTheaterInboxCapability | null }) {
  const t = getT(language);
  const { view } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const snapshot = useInboxSnapshot(inbox);
  const [busy, setBusy] = useState(false);
  // 언어를 먼저 알린다 — 첫 읽기부터 서버가 사람의 언어를 기억한다.
  noteCommodoreLanguage(language);
  useEffect(() => { void loadCommodore(theaterId); }, [theaterId]);
  // 줄에 머무는(또는 키보드로 들어온) 동안 사이드바에서 사령관의 목표 표식이 함께 밝아진다. 줄이 사라지면 거둔다.
  useEffect(() => () => setCommodorePeek(null), [theaterId]);
  const peek = (inside: boolean) => () => setCommodorePeek(inside ? theaterId : null);

  const on = view?.state.autonomy === true;
  // 사령관이 턴을 도는 동안 — 제목에 채팅 라이브 줄과 같은 물결이 흐른다. 턴이 끝나면 바로 멈춘다.
  const turn = on && view?.run.phase === "turn";
  // 대화 중심 화면이면 줄은 가운데 칸의 사령관 대화를 연다(Inbox 시트 대신). 꺼져 있으면 지금처럼 Inbox 다.
  const conversation = useCommodoreConversation();
  const preview = conversation.active ? commodorePreview(t, theaterId, board.objectives) : null;
  // 이 Theater 의 Inbox 가 사령관 섹션을 보이는 동안(대화 중심 화면이면 가운데 칸에 이 Theater 사령관이 선 동안) 줄이 펼친 상태다.
  const inboxOpen = snapshot?.theaterId === theaterId && snapshot.address.sectionId === COMMODORE_SECTION_ID;
  const open = conversation.active ? conversation.theaterId === theaterId : inboxOpen;
  const onLog = inboxOpen && snapshot?.address.pageId === "log";
  // 이미 이 Theater 의 기록 칸이면 닫는다(옛 줄의 여닫기). 다른 칸·다른 Theater 면 기록으로 옮긴다.
  const activate = (target: HTMLElement) => {
    if (conversation.active && openCommodoreConversation(theaterId)) return;
    if (!inbox) return;
    if (onLog) inbox.close();
    else inbox.open({ theaterId, sectionId: COMMODORE_SECTION_ID, pageId: "log", returnFocus: target });
  };
  const { meta, patrol, errorReason } = commodoreSummary(t, view, board.objectives);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (busy || !view) return;
    setBusy(true);
    void setCommodoreAutonomy(theaterId, !on).catch(() => undefined).finally(() => setBusy(false));
  };
  const switchTitle = [on ? t("objectives.commodore.switchOnTitle") : t("objectives.commodore.switchOffTitle"), errorReason].filter(Boolean).join("\n");

  return (
    <div className={`objectives-commodore-row${open ? " is-open" : ""}${on ? " is-on" : ""}${turn ? " is-turn" : ""}`} data-theater-id={theaterId}
      onMouseEnter={peek(true)} onMouseLeave={peek(false)} onFocus={peek(true)} onBlur={peek(false)}>
      <button
        type="button"
        role="switch"
        className="objectives-commodore-switch"
        aria-checked={on}
        aria-label={t("objectives.commodore.switchAria")}
        aria-busy={busy || undefined}
        disabled={!view}
        title={switchTitle}
        onClick={toggle}
      >
        <CommodoreMentionGlyph className="objectives-commodore-switch-glyph" />
      </button>
      <button
        type="button"
        className="objectives-commodore-row-main"
        aria-expanded={open}
        aria-label={[t("objectives.commodore.rowAria", { theater: theaterLabel }), ...meta.map((part) => part.text), patrol ?? ""].filter(Boolean).join(", ")}
        title={[meta.map((part) => part.text).join(" · "), patrol, errorReason].filter(Boolean).join("\n")}
        onClick={(event) => activate(event.currentTarget)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === "Escape" && inboxOpen) { event.preventDefault(); inbox?.close(); } }}
      >
        <span className="objectives-commodore-row-title">{t("objectives.commodore.name")}</span>
        <span className="objectives-commodore-row-meta" aria-hidden="true">
          {meta.map((part, index) => (
            <span key={part.key} className={part.tone ? `is-${part.tone}` : undefined}>{index > 0 ? " · " : ""}{part.text}</span>
          ))}
        </span>
        {preview ? <span className="objectives-commodore-row-preview" aria-hidden="true">{preview}</span> : null}
      </button>
    </div>
  );
}

type CommodoreView = ReturnType<typeof useCommodore>["view"];
export type CommodoreMetaPart = { readonly key: string; readonly text: string; readonly tone?: "on" | "warn" };

/**
 * 사령관의 지금을 말하는 짧은 조각들 — 사이드바 줄과 모바일 드로어·화면이 같은 말을 쓴다.
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
