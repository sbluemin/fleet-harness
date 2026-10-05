import { isRosterFallbackGroup } from "@fleet-console/sdk/models";

import { openPane } from "../../../core/client/src/chrome/pane/pane-store.js";
import { openRailPanel } from "../../../core/client/src/chrome/rail/rail-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { navigateConsoleRoute } from "../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../core/client/src/integration/view-mode-store.js";
import { pluginSettingsSectionId, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../../settings/client/settings-entry.js";
import { aiGatewaySettingsSection } from "./settings.js";

export { isRosterFallbackGroup };

/**
 * Settings › AI Gateway의 주소 id. 이 섹션은 플러그인 id가 없는 코어 실행 기능(agentExecution)이 등록하므로 그 공급자
 * 아래의 id다 — 설정 패널·폰 설정 화면과 같은 조립 함수로 만든다.
 */
const AI_GATEWAY_SETTINGS_SECTION = pluginSettingsSectionId(null, aiGatewaySettingsSection.id);

/** Settings › AI Gateway — 데스크톱은 레일의 설정 패널, 폰은 설정 화면의 그 섹션. */
export function openAiGatewaySettings(): void {
  if (getViewModeSnapshot().effective === "mobile") {
    navigateConsoleRoute("/settings", `?section=${encodeURIComponent(AI_GATEWAY_SETTINGS_SECTION)}`);
    return;
  }
  openRailPanel(SETTINGS_RAIL_ENTRY_ID);
  openPane({ paneId: SETTINGS_PANE_ID, params: { section: AI_GATEWAY_SETTINGS_SECTION } });
}

/**
 * 로스터가 비어 실행이 최후 폴백(Sonnet)으로 서는 띠의 머리 — 공급자 띠 대신 그 사실과 AI Gateway로 가는 길을 말한다.
 * 공유 선택기의 빈 로스터 문구와 같은 말을 쓴다.
 */
export function RosterFallbackNotice({ className, onOpened }: {
  readonly className?: string;
  /** 링크로 설정을 연 뒤 — 그 위를 덮는 메뉴는 여기서 스스로 닫는다. */
  readonly onOpened?: () => void;
}) {
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
        onClick={(event) => { event.stopPropagation(); openAiGatewaySettings(); onOpened?.(); }}
      >
        {t("settings.models.openGateway")}
      </button>
    </p>
  );
}
