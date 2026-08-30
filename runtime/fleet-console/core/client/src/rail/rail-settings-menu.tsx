import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useMenuButtonKeyboard } from "../components/use-menu-button-keyboard.js";
import { useT } from "../i18n/index.js";
import {
  closeRailPanel,
  RAIL_OVERLAY_ALPHA_DEFAULT,
  RAIL_OVERLAY_ALPHA_MAX,
  RAIL_OVERLAY_ALPHA_MIN,
  setRailOverlayAlpha,
  toggleRailPanelBehavior,
  type RailOverlayAlpha,
} from "./rail-store.js";

interface RailSettingsMenuProps {
  readonly panelBehavior: "push" | "overlay";
  readonly overlayAlpha: RailOverlayAlpha;
  /** 열려 있는 패널의 표시 이름. 패널이 없으면 null — 패널 범위 항목이 꺼진다. */
  readonly activePanelTitle: string | null;
  /** 레일 크롬이 펼쳐져 있는가. 접히면 톱니가 inert가 되므로 떠 있는 메뉴를 함께 거둔다. */
  readonly railChromeExpanded: boolean;
  readonly onResetWidth: () => void;
}

/** 메뉴와 톱니 사이 간격. group-context-menu와 같은 값을 쓴다. */
const MENU_GAP = 8;
const MENU_MIN_MARGIN = 8;

/**
 * Activity Rail 설정 진입점.
 *
 * 레일의 설정은 전부 저빈도 set-and-forget인데, 예전 호버-리빌 헤더는 콘솔에서 가장 흔한
 * 포인터 경로(패널 상단 횡단)를 방아쇠로 써서 본문을 쓰는 동안 스스로 열리고 상단 컨트롤을
 * 덮었다. 진입을 아이콘 열 최상단의 톱니로 옮겨 크롬은 부를 때만 오게 한다.
 *
 * 메뉴는 포털로 문서에 그린다 — `.right-rail`은 push 모드에서 `overflow: hidden`이라
 * 레일 안에 그리면 왼쪽으로 펼쳐지지 못하고 잘린다.
 */
export function RailSettingsMenu({ panelBehavior, overlayAlpha, activePanelTitle, railChromeExpanded, onResetWidth }: RailSettingsMenuProps) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  // 트리거가 곧 메뉴 밖 경계다 — 메뉴는 포털로 따로 서므로 훅이 둘을 각각 본다.
  useMenuButtonKeyboard(triggerRef, triggerRef, menuRef, open, setOpen);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // 톱니는 레일 우현 최상단에 선다 — 메뉴는 그 왼쪽으로 펼치고 위끝을 톱니에 맞춘다.
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor === undefined) return;
    setStyle({
      position: "fixed",
      right: Math.max(MENU_MIN_MARGIN, Math.round(window.innerWidth - anchor.left + MENU_GAP)),
      top: Math.max(MENU_MIN_MARGIN, Math.round(anchor.top)),
    });
  }, [open]);

  // 레일이 접히면 톱니는 inert가 되지만 포털된 메뉴는 문서에 그대로 남는다 — 앵커 없는
  // 메뉴가 조작 가능한 채 떠 있지 않도록 함께 거둔다. 포커스는 돌려주지 않는다(갈 곳이 없다).
  useEffect(() => {
    if (!railChromeExpanded) setOpen(false);
  }, [railChromeExpanded]);

  // 창이 움직이면 좌표가 낡는다 — 다시 계산하는 대신 닫는다(group-context-menu와 같은 계약).
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  const hasPanel = activePanelTitle !== null;
  const floating = panelBehavior === "overlay";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`right-rail-ico right-rail-settings-btn${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("rail.chrome.settings")}
        title={t("rail.chrome.settings")}
        onClick={() => setOpen((previous) => !previous)}
      >
        <GearGlyph />
      </button>
      {open && style !== null ? createPortal(
        <div
          ref={menuRef}
          className="right-rail-menu"
          role="menu"
          aria-label={t("rail.chrome.settings")}
          style={style}
        >
          {/* 플로팅·불투명도는 레일 차원의 상시 취향이라 패널이 없어도 정할 수 있다. */}
          <button
            type="button"
            role="menuitemcheckbox"
            className="right-rail-menu-item"
            aria-checked={floating}
            onClick={toggleRailPanelBehavior}
          >
            <CheckGlyph checked={floating} />
            <span>{t("rail.chrome.floatLabel")}</span>
          </button>
          {floating ? (
            <div className="right-rail-menu-row">
              <span className="right-rail-menu-row-label">{t("rail.chrome.opacityAria")}</span>
              <input
                className="right-rail-alpha-slider fleet-slider"
                type="range"
                min={RAIL_OVERLAY_ALPHA_MIN}
                max={RAIL_OVERLAY_ALPHA_MAX}
                step={1}
                value={overlayAlpha}
                aria-label={t("rail.chrome.opacityAria")}
                onChange={(event) => setRailOverlayAlpha(Number(event.currentTarget.value))}
                onDoubleClick={() => setRailOverlayAlpha(RAIL_OVERLAY_ALPHA_DEFAULT)}
                style={{ "--slider-fill": `${((overlayAlpha - RAIL_OVERLAY_ALPHA_MIN) / (RAIL_OVERLAY_ALPHA_MAX - RAIL_OVERLAY_ALPHA_MIN)) * 100}%` } as CSSProperties}
              />
              <span className="right-rail-alpha-value" aria-hidden="true">{overlayAlpha}%</span>
            </div>
          ) : null}

          <div className="right-rail-menu-divider" role="separator" />
          {/* 아래 둘은 열려 있는 패널을 겨눈다 — 이름을 붙여 범위를 밝힌다. */}
          <p className="right-rail-menu-label">{hasPanel ? activePanelTitle : t("rail.chrome.noPanel")}</p>
          <button
            type="button"
            role="menuitem"
            className="right-rail-menu-item"
            disabled={!hasPanel}
            onClick={() => { onResetWidth(); close(); }}
          >
            <span className="right-rail-menu-check" aria-hidden="true" />
            <span>{t("rail.chrome.resetWidth")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="right-rail-menu-item"
            disabled={!hasPanel}
            onClick={() => { closeRailPanel(); close(); }}
          >
            <span className="right-rail-menu-check" aria-hidden="true" />
            <span>{activePanelTitle === null ? t("rail.chrome.closePanelGeneric") : t("rail.chrome.closePanel", { title: activePanelTitle })}</span>
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** 체크 자리는 켜짐과 무관하게 늘 차지한다 — 라벨이 좌우로 흔들리지 않는다. */
function CheckGlyph({ checked }: { readonly checked: boolean }) {
  return (
    <svg className="right-rail-menu-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {checked ? <path d="m3.4 8.4 3 3 6.2-6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/**
 * 톱니 — 이가 링에 붙은 쐐기여야 16px에서 톱니로 읽힌다. 링에서 떨어진 방사선으로 그리면
 * 같은 크기에서 태양(밝기)으로 읽혀 뜻이 바뀐다. 콘솔의 설정 화면 표식(페이더)과는 일부러
 * 다른 마크다 — 이 톱니는 레일을 손보는 자리이지 설정 화면으로 가는 문이 아니다.
 */
function GearGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.33 3.66L6.36 1.87L9.64 1.87L9.67 3.66L10.93 4.39L12.49 3.51L14.13 6.36L12.59 7.27L12.59 8.73L14.13 9.64L12.49 12.49L10.93 11.61L9.67 12.34L9.64 14.13L6.36 14.13L6.33 12.34L5.07 11.61L3.51 12.49L1.87 9.64L3.41 8.73L3.41 7.27L1.87 6.36L3.51 3.51L5.07 4.39Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
