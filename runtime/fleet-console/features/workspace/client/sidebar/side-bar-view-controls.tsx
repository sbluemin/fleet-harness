import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../../../settings/client/global-settings-store.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { toggleTheaterStatusAxis } from "./group-collapse-store.js";

// 상태별 보기 — 바로 옆 chevron 과 같은 Theater 하나만 바꾼다. 표시 선호는 Theater JSON 에 남는다.
export function SideBarStatusViewToggle({ active, theaterId, theaterName }: { readonly active: boolean; readonly theaterId: string; readonly theaterName: string }) {
  const t = useT();
  const label = t("sidebar.view.byStatus", { theater: theaterName });
  return (
    <button
      type="button"
      className="side-bar-theater-row-btn side-bar-status-view-toggle"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => toggleTheaterStatusAxis(theaterId)}
    >
      <StatusViewIcon />
    </button>
  );
}

function StatusViewIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.6v10.8M5 13.4 2.8 11.2M5 13.4l2.2-2.2M11 13.4V2.6M11 2.6 8.8 4.8M11 2.6l2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// 사이드바 보기 메뉴(「⋯」) — 한 번 정하면 오래 두는 사이드바 선호가 사는 자리다. 자주 뒤집는 보기 스위치(상태별 보기)와
// 같은 줄에 버튼을 늘리지 않고 메뉴 안에 둔다. 켜 둔 선호가 있으면 버튼 아래 brass 다텀이 상태별 보기의 눌림과 같은 말로
// 그 사실을 계속 보인다. 저장은 전역 설정(서버 durable)이라 다른 창과 다음 실행도 같은 손버릇을 쓴다.
export function SideBarViewMenu() {
  const t = useT();
  const settings = useGlobalSettingsStore();
  const doubleClickOpen = settings.state?.sideBarDoubleClickOpen === true;
  const datum = doubleClickOpen;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const close = useCallback(() => setAnchor(null), []);
  returnFocusRef.current = buttonRef.current;
  useContextMenuKeyboard({ open: anchor !== null, menuSelector: '.side-bar-view-menu[role="menu"]', returnFocusRef, onEscape: close });

  // 버튼은 사이드바 우단 가까이에 선다 — 왼쪽 변을 버튼에 맞추되 실측 폭으로 뷰포트 안에 붙든다.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8));
    setStyle({ position: "fixed", left, top: Math.round(anchor.bottom + 6) });
  }, [anchor]);

  const label = t(doubleClickOpen ? "sidebar.view.menuDoubleClickOn" : "sidebar.view.menu");
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="side-bar-view-menu-button"
        data-on={datum ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={label}
        title={label}
        onClick={(event) => {
          if (anchor) { close(); return; }
          setStyle(undefined);
          setAnchor(event.currentTarget.getBoundingClientRect());
        }}
      >
        <MoreIcon />
      </button>
      {anchor ? createPortal(
        <div className="group-context-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={close}>
          <div
            ref={menuRef}
            className="group-context-menu-card side-bar-view-menu"
            role="menu"
            aria-label={t("sidebar.view.menu")}
            style={style ?? { position: "fixed", left: 0, top: 0, visibility: "hidden" }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={`group-context-menu-item side-bar-view-menu-item${doubleClickOpen ? " is-selected" : ""}`}
              role="menuitemcheckbox"
              aria-checked={doubleClickOpen}
              /* 저장 중 다시 누른 것은 저장소가 받지 않는다(같은 필드의 겹친 저장) — 항목을 끄면 메뉴의 키보드 초점이 사라진다. */
              onClick={() => { void setGlobalSettingsField("sideBarDoubleClickOpen", !doubleClickOpen); }}
            >
              <svg viewBox="0 0 12 12" className="group-context-menu-item__check" aria-hidden="true">
                <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="side-bar-view-menu-text">
                <span className="side-bar-view-menu-label">{t("sidebar.view.doubleClickOpen")}</span>
                <span className="side-bar-view-menu-hint">{t("sidebar.view.doubleClickOpenHint")}</span>
              </span>
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function MoreIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>;
}
