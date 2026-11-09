import type { CoreMessageKey } from "../../../../core/client/src/i18n/messages/index.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { DetailTab } from "../../../objectives/client/objectives-panel.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { objectiveTabHasContent } from "../../../objectives/client/detail-content.js";
import { useSharedFileCount } from "../../../objectives/client/shared-folder-count.js";

/** 행 글리프가 여는 팝업의 탭 — 목표·구성원·라이브러리. 상세 탭과 같은 집합이다. */
export type CommanderRowGlyphTab = DetailTab;

const GLYPH_TABS: readonly CommanderRowGlyphTab[] = ["goal", "crew", "results"];

export const TAB_LABEL_KEY: Record<CommanderRowGlyphTab, CoreMessageKey> = {
  goal: "commanderTab.rowGlyph.goal",
  crew: "commanderTab.rowGlyph.crew",
  results: "commanderTab.rowGlyph.results",
};

const GoalGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" /></svg>;
const CrewGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8M10.6 3.6a2.1 2.1 0 0 1 0 3.9M11.6 9.4c1.4.4 2.4 1.8 2.4 3.6" /></svg>;
const LibraryGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.8 13.6 5v6L8 14.2 2.4 11V5Z" /><path d="M2.6 5.1 8 8.2l5.4-3.1M8 8.2v5.8" /></svg>;

const TAB_GLYPH: Record<CommanderRowGlyphTab, () => ReactElement> = {
  goal: GoalGlyph,
  crew: CrewGlyph,
  results: LibraryGlyph,
};

/**
 * 위임(★) 왼쪽의 목표·구성원·라이브러리 글리프 — 우측 작업 탭 카드와 좌측 사이드바의 지휘관 행에 선다(팝오버·폰은 두지 않는다).
 * 누르면 그 탭을 맨 위에 둔 목표·임무·라이브러리 팝업이 열린다.
 * 쉬는 행에서는 숨고(자리도 차지하지 않는다) 가리키기·행 안 초점·펼친 행에서만 셋이 함께 나타난다 — 그 가림은
 * 카드·사이드바 CSS가 맡는다. 결정 요청(목표 쪽)은 쉬는 행에서 ★ 옆의 작은 점으로 보이고,
 * 글리프가 나타나면 해당 글리프 위의 점으로 옮겨 간다.
 */
export function CommanderRowGlyphs({ commodoreId, objectiveId, title, onGlyphTab }: {
  readonly commodoreId: string;
  readonly objectiveId: string;
  readonly title: string;
  readonly onGlyphTab: (objectiveId: string, tab: CommanderRowGlyphTab, opener: HTMLElement) => void;
}) {
  const t = useT();
  // 행의 점은 팝업 안 탭 점과 같은 원천(보드)이다 — 결정 요청이 행과 팝업에서 어긋나지 않는다.
  const board = useObjectiveBoard(commodoreId);
  const objective = board.loaded ? board.objectives.find((candidate) => candidate.id === objectiveId) ?? null : null;
  const decision = objective !== null && !!objective.decisionRequest && !objective.done;
  // 공유 폴더 파일 수는 이 행을 가리키거나 초점을 둘 때 읽는다 — 쉬는 행마다 읽지 않는다.
  const groupRef = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const row = groupRef.current?.closest<HTMLElement>(".side-bar-cluster-row");
    if (!row) return;
    const on = () => setNear(true), off = () => setNear(false);
    row.addEventListener("pointerenter", on); row.addEventListener("pointerleave", off);
    row.addEventListener("focusin", on); row.addEventListener("focusout", off);
    return () => { row.removeEventListener("pointerenter", on); row.removeEventListener("pointerleave", off); row.removeEventListener("focusin", on); row.removeEventListener("focusout", off); };
  }, []);
  const sharedFiles = useSharedFileCount(objective, near);
  return <>
    <span ref={groupRef} className="commander-row-glyphs" role="group" aria-label={t("commanderTab.rowGlyphs.label")}>
      {GLYPH_TABS.map((tab) => {
        const tabLabel = t(TAB_LABEL_KEY[tab]);
        const dotLabel = decision && tab === "goal" ? t("commanderTab.rowGlyph.decision") : null;
        const Glyph = TAB_GLYPH[tab];
        // 보여 줄 것이 하나도 없는 탭은 흐리고 열리지 않는다 — 안내 문구는 두지 않는다. 보드를 읽기 전에는 비었다고 단정하지 않는다.
        const empty = objective !== null && !objectiveTabHasContent(objective, tab, sharedFiles);
        return (
          <button
            key={tab}
            type="button"
            className="commander-row-glyph"
            aria-haspopup="dialog"
            disabled={empty}
            aria-label={`${t("commanderTab.rowGlyph.open", { tab: tabLabel, title })}${dotLabel ? ` · ${dotLabel}` : ""}`}
            title={tabLabel}
            onClick={(event) => onGlyphTab(objectiveId, tab, event.currentTarget)}
          >
            <Glyph />
            {decision && tab === "goal" ? <span className="commander-row-glyph-dot is-attention" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </span>
    {/* 쉬는 행의 점 — 결정 요청만 둔다. */}
    {decision ? (
      <span className="commander-row-pips" aria-hidden="true"><i className="is-attention" /></span>
    ) : null}
  </>;
}

/**
 * 행 글리프의 점이 읽는 보드 — 펼침 패널이 이미 올리지만, 한 번도 펼치지 않은 행의 점도 보여야 하므로
 * 작업 탭 목록이 마운트될 때 함께 올린다(행마다 올리지 않는다).
 */
export function useCommanderRowGlyphBoard(commodoreId: string): void {
  const api = objectivesApi();
  useEffect(() => {
    if (api !== null) void loadBoard(api, commodoreId);
  }, [api, commodoreId]);
}
