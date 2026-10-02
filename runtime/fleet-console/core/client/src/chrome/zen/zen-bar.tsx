import { useLayoutEffect, useRef, useState } from "react";

import { ZenIslandControls } from "../../../../../features/workspace/client/zen/zen-island-controls.js";
import { useAttentionQueue } from "../../../../../features/workspace/client/zen/use-attention-queue.js";
import { useSnapFullOperationId } from "../../../../../features/workspace/client/canvas/canvas-store.js";
import { useTriageActive, useTriageMapOpen, useTriageStage } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { useSideBarState } from "../../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useT } from "../../i18n/index.js";
import { setZenToolbarHost } from "../../integration/toolbar-slots.js";
import { useZenModeState, useZenTransitionActive } from "../../integration/zen-mode.js";
import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";
import { useRailDragDeltaPx, useRailSettledPx } from "../rail/rail-store.js";

/** 같은 도구 DOM을 보존하되, 전체 칸·무대를 보는 동안에는 아레나 모서리의 손잡이로 물러난다. */
const EDGE = 12;
/** 크롬 카드와 아레나 사이 틈 — Operations의 CHROME_FLOAT_GUTTER와 같은 값. */
const CHROME_GUTTER = 24;
const OPEN_SURFACE = '[aria-expanded="true"]:not(.console-toolbar-fold), [role="menu"], [role="dialog"], .command-band-update-bubble, .is-feature-tour-anchor';

export function ZenBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const escapeFocusRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [layout, setLayout] = useState({ viewportWidth: window.innerWidth, sidebarRight: 0 });
  const warRoom = useTriageActive();
  const staged = useTriageStage();
  const mapOpen = useTriageMapOpen();
  const snapFull = useSnapFullOperationId();
  const transitionActive = useZenTransitionActive();
  const { queue } = useAttentionQueue();
  const watching = warRoom ? staged !== null && !mapOpen : snapFull !== null;
  const receded = watching && !expanded && !held && !transitionActive;
  const zenState = useZenModeState();
  const sidebar = useSideBarState();
  const sidebarShown = zenState.sideBarRevealed && !sidebar.collapsed;
  // 레일이 점유한 폭만큼 아레나 오른쪽이 줄어든다. 레일을 끄는 동안에도 가운데를 따라간다.
  const railPx = useRailSettledPx() + useRailDragDeltaPx(active);
  const arenaRight = railPx > 0 ? railPx + CHROME_GUTTER : 0;
  useLayoutEffect(() => {
    if (!active) return;
    const element = document.querySelector<HTMLElement>(".operations-side-bar");
    // 숨김 이동(translate)과 무관한 사이드바의 자리로 아레나 왼쪽을 잰다.
    const measure = () => {
      const next = { viewportWidth: window.innerWidth, sidebarRight: sidebarShown && element ? element.offsetLeft + element.offsetWidth : 0 };
      setLayout((current) => current.viewportWidth === next.viewportWidth && current.sidebarRight === next.sidebarRight ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element) observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [active, sidebarShown]);
  useLayoutEffect(() => {
    // 섬 안의 도구(예: 지도 닫기)로 감상에 들어가면 포커스가 남은 동안 펼침을 지켜 포커스가 숨지 않게 한다.
    if (rootRef.current?.contains(document.activeElement)) return;
    setExpanded(false);
  }, [active, watching]);
  useLayoutEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    // 투어는 접힌 DOM에도 앵커 표식을 붙인다. 섬 안 앵커만 펼침을 지키고, 바깥 투어는 가리지 않는다.
    // 말풍선은 portal에 있으므로 섬 도구에서 열린 표식을 따로 읽는다.
    const measure = () => {
      const tooltip = document.querySelector(".console-toolbar-tip.is-visible[data-zen-island-tip]");
      const content = root.querySelector(".zen-bar-content");
      setHeld(Boolean(content?.querySelector(OPEN_SURFACE) || tooltip));
      setUpdateReady(Boolean(content?.querySelector(".command-band-update-dot")));
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-expanded", "aria-describedby", "aria-hidden"] });
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    // 도구모음은 별도 React portal이다. 합성 이벤트의 트리가 아닌 실제 섬 DOM 경계로 출입을 잰다.
    const enter = () => setExpanded(true);
    const leave = () => setExpanded(false);
    const focus = () => { if (!escapeFocusRef.current) setExpanded(true); };
    const blur = (event: FocusEvent) => { if (!root.contains(event.relatedTarget as Node | null)) setExpanded(false); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !watching || held) return;
      event.preventDefault();
      event.stopPropagation();
      escapeFocusRef.current = true;
      handleRef.current?.focus({ preventScroll: true });
      escapeFocusRef.current = false;
      setExpanded(false);
    };
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("focusin", focus);
    root.addEventListener("focusout", blur);
    root.addEventListener("keydown", keydown);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("focusin", focus);
      root.removeEventListener("focusout", blur);
      root.removeEventListener("keydown", keydown);
    };
  }, [active, watching, held]);
  const arenaLeft = layout.sidebarRight > 0 ? layout.sidebarRight + CHROME_GUTTER : 0;
  // 섬의 폭은 내용이 정한다. 감상 중에는 오른쪽 끝을 고정해 펼쳐도 손잡이가 포인터에서 달아나지 않는다.
  const center = (arenaLeft + layout.viewportWidth - arenaRight) / 2;

  return (
    <div ref={rootRef} className={`zen-bar${warRoom ? " is-war-room" : ""}${watching && !transitionActive ? " is-watching" : ""}${receded ? " is-receded" : ""}`} data-keep-operation-active="" hidden={!active} role="group" aria-label={t("zen.bar.aria")}
      style={{ left: watching && !transitionActive ? layout.viewportWidth - arenaRight - EDGE : center, bottom: EDGE }}>
      <span className="zen-bar-content" inert={receded || undefined} aria-hidden={receded || undefined}>
        {active ? <ZenIslandControls /> : null}
        <span className="zen-bar-toolbar" ref={setZenToolbarHost} />
      </span>
      <button ref={handleRef} type="button" className="zen-bar-brand" aria-label={t("zen.bar.aria")} aria-expanded={!receded}
        title={t("zen.bar.brand")} onClick={() => setExpanded(true)}>
        <BrandMarkIcon className="zen-bar-brand-glyph" local={local} />
        <BrandWordmark className="zen-bar-brand-wordmark" local={local} />
        {receded && queue.length ? <span className="zen-island-count zen-bar-handle-count">{queue.length}</span> : null}
        {receded && updateReady ? <span className="command-band-update-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
