import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { openWhatsNew } from "../../integration/store.js";
import { useConsoleUpdateAction } from "../components/console-update-action.js";
import { closeMobileSheets, popMobileSheet, pushMobileSheet } from "./mobile-store.js";
import { MobileSheet } from "./mobile-sheet.js";

/**
 * 폰에는 도움말 메뉴와 말풍선이 없다. 새 버전이 있다는 신호(점)와 시작하는 자리(이 시트)가 그 둘을 대신한다.
 * 점은 셸 갱신이 먼저 필요한 Console 갱신에는 서지 않는다 — 데스크톱의 도움말 점과 같은 뜻이다.
 */
export function useMobileUpdateReady(): boolean {
  const state = useConsoleState();
  return state.updateAvailable && !state.shellUpdateRequired && state.latestVersion !== null;
}

export function openMobileUpdateSheet(): void {
  pushMobileSheet({ kind: "custom", render: () => <MobileUpdateSheet /> });
}

/**
 * 데스크톱 업데이트 말풍선과 같은 문구와 같은 상태 머신이다: 새 버전 · 세션 비중단 · 릴리스 노트 · [업데이트].
 * 원격 리스너가 409로 동의를 요구하면 같은 시트가 경고 문구와 「호스트를 업데이트하고 다시 시작」으로 바뀐다.
 * 요청이 처리되면(수락·거절 모두) 시트는 닫힌다 — 수락 뒤는 업데이트 커튼이, 거절의 사유는 상단 배너가 말한다.
 */
function MobileUpdateSheet() {
  const t = useT();
  const { latestVersion } = useConsoleState();
  const { applyState, preparing, copy, apply } = useConsoleUpdateAction(latestVersion, t);
  const armed = applyState === "armed";
  const resting = applyState === "idle";
  const actionLabel = preparing ? t("chrome.system.update.requesting") : armed ? t("chrome.system.update.confirmHostRestartConfirm") : resting ? t("chrome.updateNotice.update") : copy.label;
  const detail = resting ? t("chrome.updateNotice.consoleInPlace") : copy.title;

  return (
    <MobileSheet
      title={t("chrome.updateNotice.title")}
      onClose={popMobileSheet}
      footer={
        <button type="button" className="mobile-pill-secondary is-inverse" disabled={preparing || copy.disabled} aria-busy={preparing || undefined} onClick={() => { void apply().then((done) => { if (done) closeMobileSheets(); }); }}>
          {actionLabel}
        </button>
      }
    >
      <div className="mobile-update-sheet" role="status" aria-live="polite">
        <strong>{t("chrome.updateNotice.consoleAvailable", { version: latestVersion ?? "" })}</strong>
        <p className={armed ? "is-warn" : undefined}>{detail}</p>
        <button type="button" className="mobile-update-sheet-link" onClick={() => { closeMobileSheets(); openWhatsNew(); }}>{t("chrome.updateNotice.releaseNotes")}</button>
      </div>
    </MobileSheet>
  );
}
