import { useT } from "../../i18n/index.js";
import { GearGlyph } from "../../../../../features/settings/client/settings-entry.js";
import { openSettingsModal, closeSettingsModal, useSettingsModal } from "../../../../../features/settings/client/settings-door.js";
import "../../styles/rail.css";

/**
 * 설정 — 대화 중심 화면의 호스트 메뉴 맨 끝. 톱니는 메뉴가 아니라 가운데 설정 모달의 문이고(settings-door.ts), 켜짐은
 * 그 모달이 서 있는가로 읽는다. 문서 id(rail-settings-toggle)는 설정 표면의 이름표(aria-labelledby)와 온보딩 앵커가
 * 가리키므로 그대로 둔다. 버튼은 데스크톱 대화 화면에만 선다 — 모바일은 /settings 페이지를 쓴다.
 */
export function SettingsButton({ menuItem = false }: { readonly menuItem?: boolean }) {
  const t = useT();
  const modal = useSettingsModal();
  return (
    <button
      id="rail-settings-toggle"
      type="button"
      role={menuItem ? "menuitem" : undefined}
      className={`right-rail-ico right-rail-settings-btn${modal.open ? " is-active" : ""}`}
      aria-pressed={modal.open}
      aria-haspopup="dialog"
      aria-label={t("settings.title")}
      data-tip={t("settings.title")}
      onClick={() => {
        if (modal.open) closeSettingsModal(); else openSettingsModal();
      }}
    >
      <GearGlyph />
      {menuItem ? <><span className="conversation-dock-label">{t("settings.title")}</span><span className="conversation-dock-next" aria-hidden="true">›</span></> : null}
    </button>
  );
}
