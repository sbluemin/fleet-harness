import { isRosterFallbackGroup, RosterFallbackNotice } from "../../../../ai-gateway/client/roster-fallback.js";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { MobileSheet } from "../../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushBackLayer } from "../../../../../core/client/src/chrome/mobile/mobile-back.js";
import { reportSheetChrome, reportShellChrome } from "../../../../../core/client/src/chrome/mobile/mobile-chrome.js";
import { pushOverlayHistory, releaseOverlayHistory } from "../../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { resolveRowEffort } from "../../components/effort-track.js";
import { MobileEffortGateRow, MobileEffortTabs, useMobileEffortGate } from "../../components/mobile-quick-launch.js";
import { getT } from "../i18n/index.js";
import type { AgentChatCoordinatePair } from "./chat-events.js";
import "../../components/mobile-quick-launch.css";

export interface MobileCoordinateGroup {
  readonly id: string;
  readonly caption: string;
  readonly rows: readonly OperationLaunchVariantRow[];
}

/**
 * 모바일 Operation 입력창의 모델 알약이 여는 모델 시트(impl-spec S-11b, S-27) — 새 작업 시트의 모델 시트와 같은 문법이다:
 * 라디오 묶음 행으로 모델을 고르고, 그 아래 「추론 강도」 글자 탭으로 강도를 고른다. 고르면 값만 바뀌고 시트는 열려 있다.
 * 데스크톱 좌표 메뉴와 같은 카탈로그·적용 경로(`apply`)를 쓰므로, 두 표면이 같은 세션 좌표를 다르게 바꾸지 않는다.
 */
export function MobileCoordinateSheet({
  groups,
  target,
  current,
  occupied,
  working,
  failed,
  language,
  formatTokens,
  onApply,
  onCompact,
  onClose,
}: {
  /** 카탈로그를 아직 못 읽었으면 `null`. */
  readonly groups: readonly MobileCoordinateGroup[] | null;
  /** 다음 턴에 도는 좌표(예약이 있으면 예약). */
  readonly target: AgentChatCoordinatePair | null;
  /** 지금 도는 좌표 — 창이 작은 모델을 막을 때 지금 모델은 막지 않는다. */
  readonly current: AgentChatCoordinatePair | null;
  readonly occupied: number | null;
  readonly working: boolean;
  readonly failed: boolean;
  readonly language: "en" | "ko";
  readonly formatTokens: (tokens: number) => string;
  readonly onApply: (next: AgentChatCoordinatePair) => void;
  readonly onCompact: () => void;
  readonly onClose: () => void;
}) {
  const t = getT(language);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  // 하드웨어·브라우저 뒤로는 화면을 떠나지 않고 시트를 닫는다(새 작업 시트와 같은 계약), 떠 있는 동안 아래 시스템 바는 시트 면이다(S-03).
  React.useEffect(() => {
    let id: number | null = pushOverlayHistory(() => { id = null; closeRef.current(); });
    const releaseLayer = pushBackLayer(() => closeRef.current());
    reportSheetChrome();
    return () => {
      releaseLayer();
      if (id !== null) releaseOverlayHistory(id);
      reportShellChrome();
    };
  }, []);

  const rows = (groups ?? []).flatMap((group) => group.rows);
  const targetRow = target ? rows.find((row) => row.launch.model === target.model) ?? null : null;
  const chips = targetRow?.chips ?? [];
  const targetEffort = targetRow ? resolveRowEffort(targetRow, target?.effort ?? null) : null;
  // 강도 탭은 새 작업 모델 시트와 같은 게이트 규칙이다(S-11e ①) — 기본은 일상 단계만, 지금 좌표가 게이트 단계면 펼친 채로 연다.
  const pickEffort = (effort: string | null) => {
    const model = targetRow?.launch.model;
    if (model && effort !== targetEffort) onApply({ model, effort });
  };
  const { deck, toggleGate } = useMobileEffortGate(targetRow, targetEffort, t("terminal.chat.coordAutoEffort"), pickEffort);
  const tooLarge = (row: OperationLaunchVariantRow) => occupied !== null && row.contextWindow !== undefined
    && occupied > row.contextWindow && row.launch.model !== current?.model;
  const anyBlocked = rows.some(tooLarge);

  return createPortal(
    <MobileSheet title={t("terminal.chat.coordSheetTitle")} onClose={onClose} className="mql-sheet">
      {groups === null ? <p className="mql-glab">{t("terminal.chat.coordMenuLoading")}</p> : null}
      {(groups ?? []).map((group) => (
        <React.Fragment key={group.id}>
          {isRosterFallbackGroup(group.id) ? <RosterFallbackNotice className="mql-glab" /> : (groups?.length ?? 0) > 1 ? <h3 className="mql-glab">{group.caption}</h3> : null}
          <div className="mql-grp" role="radiogroup" aria-label={group.caption}>
            {group.rows.map((row) => {
              const blocked = tooLarge(row);
              const active = row.launch.model === target?.model;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={blocked || undefined}
                  className={`mql-gr${blocked ? " is-two" : ""}`}
                  onClick={() => {
                    const model = row.launch.model;
                    if (blocked || active || !model) return;
                    // 고른 강도가 새 모델의 사다리에 없으면 자동으로 떨어진다 — 데스크톱 메뉴·런치와 같은 규칙.
                    onApply({ model, effort: resolveRowEffort(row, target?.effort ?? null) });
                  }}
                >
                  <span className={`mql-radio${active ? " is-on" : ""}`} aria-hidden="true" />
                  <span className="mql-gr-tx">
                    {row.label}
                    {blocked && occupied !== null && row.contextWindow !== undefined ? (
                      <small>{t("terminal.chat.coordMenuTooLarge", { used: formatTokens(occupied), window: formatTokens(row.contextWindow) })}</small>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </React.Fragment>
      ))}
      {targetRow && chips.length > 0 ? (
        <>
          <h3 className="mql-glab">{t("terminal.chat.coordMenuEffortTrack")}</h3>
          <MobileEffortTabs deck={deck} label={t("terminal.chat.coordMenuEffortTrack")} onPick={pickEffort} />
          {/* 옵션은 펼치기 한 행뿐이다 — 다이나믹 워크플로우는 새 작업 전용이라 Operation 시트에 두지 않는다(S-56 NT-1d). */}
          {deck.hasGate ? <h3 className="mql-glab is-options">{t("terminal.chat.coordSheetOptions")}</h3> : null}
          {deck.hasGate ? (
            <div className="mql-grp">
              <MobileEffortGateRow deck={deck} onToggle={toggleGate} />
            </div>
          ) : null}
        </>
      ) : null}
      {anyBlocked ? (
        <div className="mobile-sheet-foot">
          <button type="button" className="mobile-pill-secondary" onClick={() => { onClose(); onCompact(); }}>{t("terminal.chat.coordMenuCompactFirst")}</button>
        </div>
      ) : null}
      {failed || working ? (
        <p className="mql-glab" role="status">{failed ? t("terminal.chat.coordMenuFailed") : t("terminal.chat.coordMenuNextTurn")}</p>
      ) : null}
    </MobileSheet>,
    // 시트 골격은 absolute다 — 앱 틀(.mobile-frame, 화면 전체의 위치 기준) 위에 띄워 입력창 쪽 조상에 갇히지 않게 한다.
    document.querySelector<HTMLElement>(".mobile-frame") ?? document.body,
  );
}
