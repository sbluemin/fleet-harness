import { useEffect } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { retargetObjectiveWindow, toggleObjectiveWindow, useObjectiveWindow } from "../../../objectives/client/objective-window.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { GLYPH_TABS, TAB_GLYPH, TAB_LABEL_KEY } from "../commander-tab/commander-row-glyphs.js";
import { useCommanderOwner } from "../commander-tab/commander-list.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";

/**
 * 지휘관·구성원 채팅 머리의 목표·구성원·라이브러리 글리프 — 우측 작업 탭 행 글리프와 같은 세 글리프·점이다. 누르면 목표 창(결과물 창과 같은
 * 떠 있는 창 하나)이 그 항목으로 열리고, 보이는 항목의 글리프를 다시 누르면 닫힌다. 창이 열린 채 다른 목표의 채팅으로 옮기면 창도 그 목표로 바뀐다.
 */
export function ObjectiveChipGlyphs({ commodoreId, objectiveId, title }: {
  readonly commodoreId: string;
  readonly objectiveId: string;
  readonly title: string;
}) {
  const t = useT();
  const shown = useObjectiveWindow();
  const board = useObjectiveBoard(commodoreId);
  const api = objectivesApi();
  useEffect(() => { if (api !== null) void loadBoard(api, commodoreId); }, [api, commodoreId]);
  useEffect(() => { retargetObjectiveWindow(objectiveId, commodoreId); }, [objectiveId, commodoreId]);
  const objective = board.loaded ? board.objectives.find((candidate) => candidate.id === objectiveId) ?? null : null;
  const decision = objective !== null && !!objective.decisionRequest && !objective.done;
  const unseen = objective !== null && objective.missions.some((mission) => unseenRecords(mission) > 0);
  const openTab = shown !== null && shown.objectiveId === objectiveId ? shown.tab : null;
  return (
    <span className="conversation-objective-glyphs" role="group" aria-label={t("commanderTab.chatGlyphs.label")} data-keep-objective-active="">
      {GLYPH_TABS.map((tab) => {
        const pressed = openTab === tab;
        const tabLabel = t(TAB_LABEL_KEY[tab]);
        const dot = decision && tab === "goal" ? "is-attention" : unseen && tab === "crew" ? "is-unseen" : null;
        const dotLabel = dot === "is-attention" ? ` · ${t("commanderTab.rowGlyph.decision")}` : dot === "is-unseen" ? ` · ${t("commanderTab.rowGlyph.unseen")}` : "";
        const Glyph = TAB_GLYPH[tab];
        return (
          <button
            key={tab}
            type="button"
            className="commander-row-glyph conversation-objective-glyph"
            aria-pressed={pressed}
            aria-haspopup="dialog"
            aria-label={`${t(pressed ? "commanderTab.chatGlyph.close" : "commanderTab.chatGlyph.open", { tab: tabLabel, title })}${dotLabel}`}
            title={tabLabel}
            onClick={(event) => toggleObjectiveWindow({ objectiveId, commodoreId, tab }, event.currentTarget)}
          >
            <Glyph />
            {dot !== null ? <span className={`commander-row-glyph-dot ${dot}`} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </span>
  );
}

/**
 * 상단칩 앞머리 — 「사령관 ⇄ 목표」의 사령관 쪽. 이 목표가 어느 사령관의 것인지 말하고, 누르면 우측 사이드바(그 사령관의 작업·정보·설정)를
 * 여닫는다 — 사령관 대화의 칩과 같은 동작이다. 칩의 나머지(목표 아바타·제목·구성원 수)는 목표 쪽 단추이고 목표 창을 연다.
 */
export function ObjectiveChipCommodore({ commodoreId, onPress }: { readonly commodoreId: string; readonly onPress: () => void }) {
  const t = useT();
  const owner = useCommanderOwner(commodoreId);
  const label = t("commanderTab.chatPill.commodore", { name: owner.name });
  return (
    <span className="conversation-pill-commodore">
      <button type="button" className="conversation-pill-commodore-part" aria-label={label} title={label} onClick={onPress}>
        <CommodoreAvatar commodoreId={commodoreId} state={owner.state} size={20} label="" decorative className="conversation-pill-mark" />
        <span className="conversation-pill-title">{owner.name}</span>
      </button>
      <svg className="conversation-pill-swap" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 8h15m0 0-3.5-3.5M19 8l-3.5 3.5M20 16H5m0 0 3.5-3.5M5 16l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
