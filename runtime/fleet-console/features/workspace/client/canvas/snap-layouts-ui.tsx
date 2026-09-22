// Cruise 스냅의 표면 셋 — 끌던 패널이 위쪽 띠에 닿으면 내려오는 레이아웃 바, 놓일 자리를 미리
// 보이는 고스트, 최대화 버튼에 머무르면 열리는 배치 메뉴. 셋 다 캔버스 박스 좌표에 절대 배치되고
// 월드 변환을 타지 않는다 — 칸은 화면의 것이지 월드의 것이 아니다.

import { forwardRef, useEffect, useRef, type CSSProperties } from "react";

import { useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { SNAP_PRESETS, type SnapPreset, type SnapPresetId, type SnapRect } from "./snap-layouts.js";

const PRESET_LABEL_KEY: Readonly<Record<SnapPresetId, CoreMessageKey>> = {
  half: "canvas.snap.presetHalf",
  thirds: "canvas.snap.presetThirds",
  quad: "canvas.snap.presetQuad",
  wide: "canvas.snap.presetWide",
  stack: "canvas.snap.presetStack",
};

export interface SnapZoneRef {
  readonly presetIndex: number;
  readonly zoneIndex: number;
}

// 프리셋 그림은 6×2 격자로 그린다 — ⅓·½·⅔가 모두 정수 칸에 떨어지는 가장 작은 격자다.
function zoneGridStyle(zone: SnapPreset["zones"][number]): CSSProperties {
  const [fx, fy, fw, fh] = zone;
  return {
    gridColumn: `${Math.round(fx * 6) + 1} / span ${Math.max(1, Math.round(fw * 6))}`,
    gridRow: `${Math.round(fy * 2) + 1} / span ${Math.max(1, Math.round(fh * 2))}`,
  };
}

interface SnapPresetGlyphProps {
  readonly preset: SnapPreset;
  readonly presetIndex: number;
  readonly hot: number | null;
  readonly interactive: boolean;
  readonly onPick?: (zone: SnapZoneRef) => void;
}

function SnapPresetGlyph({ preset, presetIndex, hot, interactive, onPick }: SnapPresetGlyphProps) {
  const t = useT();
  const label = t(PRESET_LABEL_KEY[preset.id]);
  return (
    <div className={`canvas-snap-preset${hot !== null ? " is-hot" : ""}`} data-snap-preset={presetIndex} role={interactive ? "group" : undefined} aria-label={interactive ? label : undefined}>
      {preset.zones.map((zone, zoneIndex) => interactive ? (
        <button
          key={zoneIndex}
          type="button"
          role="menuitem"
          className={`canvas-snap-zone${hot === zoneIndex ? " is-hot" : ""}`}
          data-snap-preset={presetIndex}
          data-snap-zone={zoneIndex}
          style={zoneGridStyle(zone)}
          aria-label={t("canvas.snap.zoneAria", { preset: label, index: zoneIndex + 1 })}
          onClick={() => onPick?.({ presetIndex, zoneIndex })}
        />
      ) : (
        <span
          key={zoneIndex}
          className={`canvas-snap-zone${hot === zoneIndex ? " is-hot" : ""}`}
          data-snap-preset={presetIndex}
          data-snap-zone={zoneIndex}
          style={zoneGridStyle(zone)}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

interface SnapHandleProps {
  /** 캡션을 끌기 시작하면 내려오고, 바가 열리거나 드래그가 끝나면 걷힌다. */
  readonly visible: boolean;
  /** 캔버스 박스 좌표 — 아레나 가로 중심 x, Command Band 아랫변 y. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly width: number;
}

/** 드래그가 시작되면 Command Band에서 뽑혀 내려오는 넓은 손잡이 — "여기로 올리면 분할 배치"의 예고. 띠에 닿으면 바로 자란다. */
export function SnapHandle({ visible, anchorX, anchorY, width }: SnapHandleProps) {
  return <div className={`canvas-snap-handle${visible ? " is-on" : ""}`} style={{ left: anchorX, top: anchorY, width }} aria-hidden="true" />;
}

interface SnapLayoutBarProps {
  readonly open: boolean;
  readonly hover: SnapZoneRef | null;
  /** 캔버스 박스 좌표 — 아레나 가로 중심 x, 바 윗변 y. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/** 드래그 중에만 뜨는 프리셋 바. 포인터는 캡션이 잡고 있으므로 바는 히트테스트만 당하고 입력은 받지 않는다. */
export const SnapLayoutBar = forwardRef<HTMLDivElement, SnapLayoutBarProps>(function SnapLayoutBar({ open, hover, anchorX, anchorY }, ref) {
  const t = useT();
  return (
    <div
      ref={ref}
      className={`canvas-snap-bar${open ? " is-open" : ""}`}
      style={{ left: anchorX, top: anchorY }}
      role="toolbar"
      aria-label={t("canvas.snap.barAria")}
      aria-hidden={!open}
    >
      {SNAP_PRESETS.map((preset, presetIndex) => (
        <SnapPresetGlyph key={preset.id} preset={preset} presetIndex={presetIndex} hot={hover?.presetIndex === presetIndex ? hover.zoneIndex : null} interactive={false} />
      ))}
    </div>
  );
});

interface SnapGhostProps {
  /** 캔버스 박스 좌표의 시각 프레임(캡션 포함). */
  readonly rect: SnapRect | null;
}

export function SnapGhost({ rect }: SnapGhostProps) {
  // 사라질 때 마지막 자리를 기억해 opacity만 잦아들게 한다 — 크기가 0으로 접히면 잔상이 튄다.
  const lastRef = useRef<SnapRect | null>(null);
  if (rect) lastRef.current = rect;
  const shown = rect ?? lastRef.current;
  if (!shown) return null;
  return (
    <div
      className={`canvas-snap-ghost${rect ? " is-on" : ""}`}
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
      aria-hidden="true"
    />
  );
}

interface SnapLayoutMenuProps {
  readonly title: string;
  /** 캔버스 박스 좌표 — 메뉴의 오른쪽 변을 앵커 오른쪽 변에 맞추고 앵커 아래에 선다. */
  readonly anchor: SnapRect;
  readonly boundsWidth: number;
  readonly onPick: (zone: SnapZoneRef) => void;
  readonly onClose: () => void;
}

/** 캡션 최대화 버튼에 머무르면 열리는 배치 메뉴. 포인터가 메뉴와 앵커에서 멀어지면 스스로 닫힌다. */
export function SnapLayoutMenu({ title, anchor, boundsWidth, onPick, onClose }: SnapLayoutMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    // 마우스가 앵커·메뉴 둘 다에서 24px 넘게 벗어나면 닫는다 — 클릭 없이 지나가는 hover 메뉴의 예의다.
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const menu = menuRef.current?.getBoundingClientRect();
      if (!menu) return;
      const margin = 24;
      const inMenu = event.clientX >= menu.left - margin && event.clientX <= menu.right + margin && event.clientY >= menu.top - margin && event.clientY <= menu.bottom + margin;
      if (inMenu) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("wheel", onClose, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("wheel", onClose, { capture: true });
    };
  }, [onClose]);
  const width = SNAP_PRESETS.length * 70 + 6;
  const left = Math.max(8, Math.min(boundsWidth - width - 8, anchor.x + anchor.width - width));
  return (
    <div
      ref={menuRef}
      className="canvas-snap-menu"
      role="menu"
      aria-label={t("canvas.snap.menuAria", { title })}
      style={{ left, top: anchor.y + anchor.height + 6 }}
      // 메뉴 안의 포인터다운이 캔버스 팬/빈 바다 클릭으로 새지 않게 막는다.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {SNAP_PRESETS.map((preset, presetIndex) => (
        <SnapPresetGlyph key={preset.id} preset={preset} presetIndex={presetIndex} hot={null} interactive onPick={onPick} />
      ))}
    </div>
  );
}
