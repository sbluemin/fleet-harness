import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useSideBarShortcutLabel, useSideBarStatusViewShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../../../settings/client/global-settings-store.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { setSideBarCollapsed, toggleSideBarStatusAxis, useSideBarState } from "./operations-side-bar-store.js";

// 접기는 패널 자신의 동사다(Periscope 문법 — 밴드 토글 퇴역). 도킹 중에는 접기 셰브런이,
// 엣지 독이 되부른 픽(오버레이) 중에는 같은 자리가 "열어 두기"(고정)로 바뀐다 — 픽에서
// 접기는 무의미하고(이미 접혀 있다) 남는 결정은 고정뿐이라, 한 자리가 두 낱말을 나눠 쓴다.
// Map 사이드바와 War Room 선별 사이드바가 같은 접힘 상태를 쓰므로 컨트롤도 한 벌이다.
export function SideBarCollapseControl() {
  const t = useT();
  const { collapsed, peeking } = useSideBarState();
  const shortcut = useSideBarShortcutLabel();
  // 접힌 채 픽도 아니면 카드 자체가 없다 — 컨트롤의 문은 엣지 독이 진다.
  if (collapsed && !peeking) return null;
  const pinning = collapsed && peeking;
  const label = t(pinning ? "sidebar.chrome.keepOpen" : "sidebar.chrome.collapse", { shortcut });
  return (
    <button
      type="button"
      className="side-bar-collapse"
      aria-label={label}
      title={label}
      onClick={() => setSideBarCollapsed(!pinning)}
    >
      {pinning ? <KeepOpenIcon /> : <CollapseIcon />}
    </button>
  );
}

// 접기 방향(좌측 엣지)을 가리키는 단일 셰브런 — 엣지 독 트리거의 펼침 셰브런과 한 쌍이다.
function CollapseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.6 5.4 8l4.4 4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function KeepOpenIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 2.5h5.6M6.4 2.5v3.1L4.6 7.7v1h6.8v-1L9.6 5.6V2.5M8 8.7v4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// 상태별 보기 토글 — 목록을 Theater 묶음에서 대기·실행 중·유휴의 평면 목록으로 뒤집는 하나짜리
// 세션 스위치다. 눌림(aria-pressed)은 레일 아이콘의 켜짐과 같은 문법(brass 잉크·어두운 면)으로
// "지금 이 보기"를 말한다. 축은 의도적으로 세션 메모리에만 산다(operations-side-bar-store).
export function SideBarStatusViewToggle({ active }: { readonly active: boolean }) {
  const t = useT();
  const label = t("sidebar.view.byStatus", { shortcut: useSideBarStatusViewShortcutLabel() });
  return (
    <button
      type="button"
      className="side-bar-status-view-toggle"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => toggleSideBarStatusAxis()}
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
        data-on={doubleClickOpen ? "true" : undefined}
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
