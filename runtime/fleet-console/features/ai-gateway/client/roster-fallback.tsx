import { isRosterFallbackGroup } from "@fleet-console/sdk/models";

import { openPane } from "../../../core/client/src/chrome/pane/pane-store.js";
import { openRailPanel } from "../../../core/client/src/chrome/rail/rail-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { navigateConsoleRoute } from "../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../core/client/src/integration/view-mode-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../../settings/client/settings-entry.js";
import { aiGatewaySettingsSection } from "./settings.js";

export { isRosterFallbackGroup };

/** Settings › AI Gateway — 데스크톱은 레일의 설정 패널, 폰은 설정 화면의 그 섹션. */
export function openAiGatewaySettings(): void {
  if (getViewModeSnapshot().effective === "mobile") {
    navigateConsoleRoute("/settings", `?section=${encodeURIComponent(aiGatewaySettingsSection.id)}`);
    return;
  }
  openRailPanel(SETTINGS_RAIL_ENTRY_ID);
  openPane({ paneId: SETTINGS_PANE_ID, params: { section: aiGatewaySettingsSection.id } });
}

/**
 * 로스터가 비어 실행이 최후 폴백(Sonnet)으로 서는 띠의 머리 — 공급자 띠 대신 그 사실과 AI Gateway로 가는 길을 말한다.
 * 공유 선택기의 빈 로스터 문구와 같은 말을 쓴다.
 */
export function RosterFallbackNotice({ className }: { readonly className?: string }) {
  const t = useT();
  return (
    <p className={["roster-fallback-note", className ?? ""].filter(Boolean).join(" ")} role="note">
      <span className="roster-fallback-badge">{t("settings.models.fallback")}</span>
      <span className="roster-fallback-copy">{t("settings.models.empty")}</span>
      <button
        type="button"
        className="roster-fallback-link"
        // 메뉴의 바깥 누름·초점 이동으로 닫히기 전에 연다.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.stopPropagation(); openAiGatewaySettings(); }}
      >
        {t("settings.models.openGateway")}
      </button>
    </p>
  );
}
