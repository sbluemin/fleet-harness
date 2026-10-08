import { useLayoutEffect, useEffect, useRef, useState } from "react";

import { WarRoomIslandControls } from "../../../../../features/workspace/client/war-room/war-room-island-controls.js";
import { useAttentionQueue } from "../../../../../features/workspace/client/war-room/use-attention-queue.js";
import { useHasBottomSnappedOperation, useSnapFullOperationId } from "../../../../../features/workspace/client/canvas/canvas-store.js";
import { useTriageActive, useTriageMapOpen, useTriageStage } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { useSideBarState } from "../../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useT } from "../../i18n/index.js";
import { setWarRoomToolbarHost } from "../../integration/toolbar-slots.js";
import { useWarRoomChromeState, useWarRoomTransitionActive } from "../../integration/war-room-chrome.js";
import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";
import { useRailDragDeltaPx, useRailSettledPx } from "../rail/rail-store.js";

/** 같은 도구 DOM을 보존하되, 전체 칸·스냅 칸·무대를 보는 동안에는 아레나 모서리의 손잡이로 물러난다. */
const EDGE = 12;
/** 크롬 카드와 아레나 사이 틈 — Operations의 CHROME_FLOAT_GUTTER와 같은 값. */
const CHROME_GUTTER = 24;
const OPEN_SURFACE = '[aria-expanded="true"]:not(.console-toolbar-fold), [role="menu"], [role="dialog"], .command-band-update-bubble, .is-feature-tour-anchor';

/**
 * 펼친 섬의 자연 폭. 접힌 동안에는 도구 줄이 0fr 칸 안에서 눌려 scrollWidth가 실제 폭을 말하지 않으므로,
 * 화면 밖에 펼친 상태의 복제본을 잠깐 세워 잰다(전이·감상 폭 제한 없이).
 */
function measureIntrinsicWidth(root: HTMLElement): number {
  const probe = root.cloneNode(true) as HTMLElement;
  probe.classList.remove("is-receded", "is-receding", "is-watching");
  probe.removeAttribute("hidden");
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("inert", "");
  probe.style.cssText = "left:-10000px;bottom:0;visibility:hidden;pointer-events:none;transition:none;";
  for (const node of probe.querySelectorAll<HTMLElement>("*")) node.style.transition = "none";
  document.body.appendChild(probe);
  const width = probe.offsetWidth;
  probe.remove();
  return width;
}

export function WarRoomBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const escapeFocusRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [cause, setCause] = useState<"snap" | "hover">("snap");
  const [receding, setReceding] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState(880);
  const [layout, setLayout] = useState({ viewportWidth: window.innerWidth, sidebarRight: 0 });
  const warRoom = useTriageActive();
  const staged = useTriageStage();
  const mapOpen = useTriageMapOpen();
  const snapFull = useSnapFullOperationId();
  const snapBottomTouching = useHasBottomSnappedOperation();
  const transitionActive = useWarRoomTransitionActive();
  const { queue } = useAttentionQueue();
  const watching = warRoom ? staged !== null && !mapOpen : snapFull !== null || snapBottomTouching;
  const receded = watching && !expanded && !held && !transitionActive;
  const chromeState = useWarRoomChromeState();
  const sidebar = useSideBarState();
  const sidebarShown = chromeState.sideBarRevealed && !sidebar.collapsed;

  // receded 변화 시 동기적으로 receding 활성화 (전이 시작 첫 프레임부터 자연 폭 측정 보호)
  const prevRecededRef = useRef(receded);
  if (prevRecededRef.current !== receded) {
    prevRecededRef.current = receded;
    setReceding(true);
  }
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

  // 자연 폭 측정: 안정된 펼침 상태(!receded && !receding)에서만 실제 폭을 기억해
  // 전이 도중 중간 폭이 setNaturalWidth를 호출해 left 목표를 흔드는 레이아웃 되먹임을 차단한다.
  useLayoutEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      if (receded || receding) return;
      const w = root.offsetWidth;
      if (w > 100) {
        setNaturalWidth((current) => (Math.abs(current - w) > 1 ? w : current));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [active, receded, receding]);

  // 물러나 있던 동안 내용(대기 수, War Room 도구 등)이 바뀌었을 수 있다. 펼치기 시작하는 프레임에서
  // 전이 중인 바깥 폭이 아니라 내재 폭으로 다시 재어, 귀환의 첫 목표 자리부터 맞춘다.
  useLayoutEffect(() => {
    if (!active || receded) return;
    const root = rootRef.current;
    if (!root) return;
    const w = measureIntrinsicWidth(root);
    if (w > 100) {
      setNaturalWidth((current) => (Math.abs(current - w) > 1 ? w : current));
    }
  }, [active, receded]);

  // 초기 마운트 시 내재 폭(콘텐츠 scrollWidth 등)으로 자연 폭 초기화
  useLayoutEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const w = !receded && root.offsetWidth > 100 ? root.offsetWidth : measureIntrinsicWidth(root);
    if (w > 100) {
      setNaturalWidth((current) => (Math.abs(current - w) > 1 ? w : current));
    }
  }, [active]);

  const prevWatchingRef = useRef(watching);
  useLayoutEffect(() => {
    if (prevWatchingRef.current !== watching) {
      prevWatchingRef.current = watching;
      setCause("snap");
    }
    // 섬 안의 도구(예: 지도 닫기)로 감상에 들어가면 포커스가 남은 동안 펼침을 지켜 포커스가 숨지 않게 한다.
    if (rootRef.current?.contains(document.activeElement)) return;
    setExpanded(false);
  }, [active, watching]);

  useEffect(() => {
    if (!receding) return;
    const timer = window.setTimeout(() => setReceding(false), 420);
    return () => window.clearTimeout(timer);
  }, [receding]);

  useLayoutEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    // 투어는 접힌 DOM에도 앵커 표식을 붙인다. 섬 안 앵커만 펼침을 지키고, 바깥 투어는 가리지 않는다.
    // 말풍선은 portal에 있으므로 섬 도구에서 열린 표식을 따로 읽는다.
    const measure = () => {
      const tooltip = document.querySelector(".console-toolbar-tip.is-visible[data-war-room-island-tip]");
      const content = root.querySelector(".war-room-bar-content");
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
    const enter = () => { setCause("hover"); setExpanded(true); };
    const leave = () => { setCause("hover"); setExpanded(false); };
    const focus = () => { if (!escapeFocusRef.current) { setCause("hover"); setExpanded(true); } };
    const blur = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) {
        setCause("hover");
        setExpanded(false);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !watching || held) return;
      event.preventDefault();
      event.stopPropagation();
      escapeFocusRef.current = true;
      handleRef.current?.focus({ preventScroll: true });
      escapeFocusRef.current = false;
      setCause("hover");
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
  const center = (arenaLeft + layout.viewportWidth - arenaRight) / 2;

  // 자리 계산을 오른쪽 끝 기준으로 통일(translate -100% 0 고정).
  // 감상 중에는 오른쪽 끝이 아레나 오른쪽 모서리에 서고, 평상시에는 오른쪽 끝이 중심 + 자연 폭 / 2에 선다.
  const edgeX = layout.viewportWidth - arenaRight - EDGE;
  const centerX = center + naturalWidth / 2;
  const targetLeft = watching && !transitionActive ? edgeX : centerX;

  return (
    <div
      ref={rootRef}
      className={`war-room-bar${warRoom ? " is-war-room" : ""}${watching && !transitionActive ? " is-watching" : ""}${receded ? " is-receded" : ""}${receding ? " is-receding" : ""}`}
      data-keep-operation-active=""
      data-cause={cause}
      hidden={!active}
      role="group"
      aria-label={t("warRoomChrome.bar.aria")}
      style={{ left: targetLeft, bottom: EDGE }}
    >
      <span
        className="war-room-bar-track"
        inert={receded || undefined}
        aria-hidden={receded || undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "grid-template-columns") {
            setReceding(false);
          }
        }}
      >
        <span className="war-room-bar-content">
          {active ? <WarRoomIslandControls /> : null}
          <span className="war-room-bar-toolbar" ref={setWarRoomToolbarHost} />
        </span>
      </span>
      <button
        ref={handleRef}
        type="button"
        className="war-room-bar-brand"
        aria-label={t("warRoomChrome.bar.aria")}
        aria-expanded={!receded}
        title={t("warRoomChrome.bar.brand")}
        onClick={() => { setCause("hover"); setExpanded(true); }}
      >
        <BrandMarkIcon className="war-room-bar-brand-glyph" local={local} />
        <span className="war-room-bar-wordmark-track">
          <BrandWordmark className="war-room-bar-brand-wordmark" local={local} />
        </span>
        {queue.length ? <span className="war-room-island-count war-room-bar-handle-count">{queue.length}</span> : null}
        {updateReady ? <span className="command-band-update-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
