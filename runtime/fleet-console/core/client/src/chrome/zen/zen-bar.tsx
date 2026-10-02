import { useLayoutEffect, useState } from "react";

import { ZenIslandControls } from "../../../../../features/workspace/client/zen/zen-island-controls.js";
import { useTriageActive } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { useSideBarState } from "../../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useT } from "../../i18n/index.js";
import { setZenToolbarHost } from "../../integration/toolbar-slots.js";
import { useZenModeState } from "../../integration/zen-mode.js";
import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";
import { useRailDragDeltaPx, useRailSettledPx } from "../rail/rail-store.js";

/** 도구모음은 같은 DOM을 들고 옮겨 온다. 섬은 맵 아레나(사이드바·레일을 뺀 영역)의 아래 가운데에만 선다. */
const EDGE = 12;
/** 크롬 카드와 아레나 사이 틈 — Operations의 CHROME_FLOAT_GUTTER와 같은 값. */
const CHROME_GUTTER = 24;

export function ZenBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const [layout, setLayout] = useState({ viewportWidth: window.innerWidth, sidebarRight: 0 });
  const warRoom = useTriageActive();
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
  const arenaLeft = layout.sidebarRight > 0 ? layout.sidebarRight + CHROME_GUTTER : 0;
  // 섬의 폭은 내용이 정한다(max-content). 자리는 아레나 가운데 한 점과 translate -50%로만 정해 폭과 되먹임하지 않는다.
  const center = (arenaLeft + layout.viewportWidth - arenaRight) / 2;

  return (
    <div className={`zen-bar${warRoom ? " is-war-room" : ""}`} data-keep-operation-active="" hidden={!active} role="group" aria-label={t("zen.bar.aria")}
      style={{ left: center, bottom: EDGE }}>
      {active ? <ZenIslandControls /> : null}
      <span className="zen-bar-toolbar" ref={setZenToolbarHost} />
      <span className="zen-bar-brand" title={t("zen.bar.brand")}>
        <BrandMarkIcon className="zen-bar-brand-glyph" local={local} />
        <BrandWordmark className="zen-bar-brand-wordmark" local={local} />
      </span>
    </div>
  );
}
