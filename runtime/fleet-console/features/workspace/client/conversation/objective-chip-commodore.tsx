import { useT } from "../../../../core/client/src/i18n/index.js";
import { useCommanderOwner } from "../commander-tab/commander-list.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";

/**
 * 상단칩 앞머리 — 「사령관 ⇄ 목표」의 사령관 쪽. 이 목표가 어느 사령관의 것인지 말하고, 누르면 우측 사이드바(그 사령관의 작업·정보·설정)를
 * 여닫는다 — 사령관 대화의 칩과 같은 동작이다.
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
