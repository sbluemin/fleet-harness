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
    /**
     * 칩의 자리는 부른 콘솔의 CSS px로 오는데, 이 화면의 배율은 그 콘솔과 다를 수 있다(줌은 host마다
     * 따로 저장된다). 두 뷰는 같은 창을 덮으므로 처음 잰 뷰포트 폭의 비가 곧 두 배율의 비다 — 한 번
     * 재어 두고 창이 바뀌어도 그대로 쓴다. 줌이 바뀌면 셸이 이 덮개를 걷는다.
     */
    const scaled = scaleAnchor(anchor, window.innerWidth / anchor.viewportWidth);
    const place = () => {
      const style = placePanel(scaled, panel.offsetWidth, window.innerWidth, window.innerHeight);
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

function scaleAnchor(anchor: HostPickerAnchor, scale: number): HostPickerAnchor {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return anchor;
  return {
    left: anchor.left * scale,
    top: anchor.top * scale,
    right: anchor.right * scale,
    bottom: anchor.bottom * scale,
    viewportWidth: anchor.viewportWidth * scale,
    viewportHeight: anchor.viewportHeight * scale,
  };
}

/**
 * 판의 자리. 칩의 오른쪽 끝에 판의 오른쪽 끝을 맞추고, 칩이 창 위쪽 절반에 있으면 아래로,
 * 아래쪽(Zen 트레이)에 있으면 위로 연다 — 도구모음 판과 같은 규칙이다.
 *
 * 부른 뒤 창이 바뀌면 칩이 어디로 갔는지 이 화면은 모른다. 칩은 자기를 세운 기준에서의 거리를
 * 지키며 따라간다 — 가운데 정렬인 command band는 창 중심에서, 오른쪽에 붙은 Zen 트레이는 오른쪽
 * 가장자리에서. 칩에 가장 가까운 기준(왼쪽·중심·오른쪽)을 그 기준으로 삼아 옮기고, 창 밖으로는
 * 내보내지 않는다.
 */
function placePanel(anchor: HostPickerAnchor, panelWidth: number, width: number, height: number): Record<string, string> {
  const center = (anchor.left + anchor.right) / 2;
  const fromLeft = center;
  const fromCenter = Math.abs(center - anchor.viewportWidth / 2);
  const fromRight = anchor.viewportWidth - center;
  const chipRight = fromCenter <= fromLeft && fromCenter <= fromRight
    ? width / 2 + (anchor.right - anchor.viewportWidth / 2)
    : fromRight < fromLeft
      ? width - (anchor.viewportWidth - anchor.right)
      : anchor.right;
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
