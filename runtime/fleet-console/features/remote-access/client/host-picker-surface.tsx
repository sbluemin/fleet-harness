import { useLayoutEffect, useRef } from "react";

import { HostSwitcher, type HostPickerAnchor, type HostPickerContext } from "../../../core/client/src/chrome/components/command-band-system-cluster.js";

/** 판과 칩 사이의 틈 — 도구모음 판(.host-switcher-panel)이 칩 아래·위에 두는 간격과 같다. */
const GAP_BELOW = 8;
const GAP_ABOVE = 10;
/** 창 가장자리에서 판이 지키는 여백. */
const EDGE = 12;

/**
 * 집이 자기 목록만 펼쳐 내주는 화면.
 *
 * 원격 콘솔을 보고 있는 동안에도 사용자가 고르는 목록은 언제나 자기 기계의 것이어야 하는데,
 * 그 목록은 집의 루프백에서만 읽을 수 있다. 그래서 이 화면은 집이 서빙하고, 셸이 보고 있던
 * 콘솔 위에 얹는다 — 목록이 원격 콘솔을 지나가지 않는 유일한 방법이다.
 *
 * 콘솔 한 벌을 통째로 띄우지 않는다. 여기 필요한 것은 호스트 박스 하나뿐이고, 그 뒤에 두 번째
 * 콘솔이 통째로 떠오르면 사용자는 자기가 어디에 서 있는지를 잃는다.
 *
 * 판은 누른 칩에 매달린다 — 도구모음에서 연 판과 같은 자리여야 사용자가 누른 곳에서 목록을 찾는다.
 */
export function HostPickerScreen({ surface }: { readonly surface: HostPickerContext }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { anchor } = surface;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = root?.querySelector<HTMLElement>(".host-switcher-panel") ?? null;
    if (anchor === null || root === null || panel === null) return;
    const place = () => {
      const style = placePanel(anchor, panel.offsetWidth, window.innerWidth, window.innerHeight);
      for (const [name, value] of Object.entries(style)) root.style.setProperty(name, value);
    };
    place();
    // 목록은 늦게 차고(폭이 바뀐다), 창은 셸이 따라 늘이고 줄인다.
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  return (
    <div ref={rootRef} className="host-picker-surface" data-anchored={anchor === null ? undefined : "true"}>
      <HostSwitcher picker={surface} />
    </div>
  );
}

/**
 * 판의 자리. 칩의 오른쪽 끝에 판의 오른쪽 끝을 맞추고, 칩이 창 위쪽 절반에 있으면 아래로,
 * 아래쪽(Zen 트레이)에 있으면 위로 연다 — 도구모음 판과 같은 규칙이다.
 *
 * 부른 뒤 창이 바뀌면 칩이 어디로 갔는지 이 화면은 모른다. 칩은 자기가 가까운 창 모서리에서의
 * 거리를 지키며 따라가므로, 그 모서리를 기준으로 옮기고 창 밖으로는 내보내지 않는다.
 */
function placePanel(anchor: HostPickerAnchor, panelWidth: number, width: number, height: number): Record<string, string> {
  const fromRight = (anchor.left + anchor.right) / 2 >= anchor.viewportWidth / 2;
  const chipRight = fromRight ? width - (anchor.viewportWidth - anchor.right) : anchor.right;
  const maxLeft = Math.max(EDGE, width - EDGE - panelWidth);
  const left = Math.min(maxLeft, Math.max(EDGE, chipRight - panelWidth));
  const below = (anchor.top + anchor.bottom) / 2 < anchor.viewportHeight / 2;
  if (below) {
    const top = Math.min(height - EDGE, Math.max(EDGE, anchor.bottom + GAP_BELOW));
    return { "--picker-left": `${left}px`, "--picker-top": `${top}px`, "--picker-bottom": "auto", "--picker-max-height": `${Math.max(0, height - EDGE - top)}px` };
  }
  const chipTop = height - (anchor.viewportHeight - anchor.top);
  const bottom = Math.min(height - EDGE, Math.max(EDGE, height - chipTop + GAP_ABOVE));
  return { "--picker-left": `${left}px`, "--picker-top": "auto", "--picker-bottom": `${bottom}px`, "--picker-max-height": `${Math.max(0, height - EDGE - bottom)}px` };
}
