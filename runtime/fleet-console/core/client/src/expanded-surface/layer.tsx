import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type {
  ExpandedSurfaceContext,
  ExpandedSurfaceDescriptor,
} from "@fleet-console/sdk/expanded-surface";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { useExpandedSurfaceDescriptors } from "../plugin-registry.js";
import { getState, subscribe } from "../store.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import {
  closeExpandedSurface,
  focusExpandedSurface,
  focusedExpandedSurfaceIndex,
  replaceExpandedSurfaceParams,
  setExpandedSurfaceWeights,
  useExpandedSurfaces,
  type ExpandedSurfaceInstance,
} from "./store.js";

/**
 * 두 최소폭을 실제 가용 폭에 맞춘다.
 *
 * 선언된 최소폭은 희망이지 물리가 아니다. 두 슬롯을 합쳐도 둘의 최소폭을 못 담는 좁은
 * 캔버스에서 최소폭을 그대로 지키면 분할선이 통째로 얼어붙어, 사용자에게는 고장으로
 * 읽힌다. 그럴 때는 비율을 지키며 함께 물러난다 — Formation 슬롯이 최소치를 실제 가용
 * 폭으로 캡하는 것과 같은 규칙이다(canvas-store의 calculateGridSlots).
 */
function fitMinimums(left: number, right: number, pair: number): readonly [number, number] {
  const total = left + right;
  if (total <= pair || total <= 0) return [left, right];
  const scale = pair / total;
  return [left * scale, right * scale];
}

/** 분할선이 넘어오지 못하는 슬롯 최소폭. 표면이 더 큰 값을 요구할 수 있다. */
const DEFAULT_MIN_SLOT_WIDTH = 280;
/** 키보드로 분할선을 미는 한 걸음. */
const KEYBOARD_STEP_PX = 24;

/**
 * 확대 표면 레이어 — 캔버스 좌표 상자 안에 정박하는 비모달 작업면.
 *
 * 캔버스 안에 portal하는 이유는 사이드바·레일 폭을 침범하지 않고 그들의 리사이즈를
 * 공짜로 따라가기 위함이다. 캔버스만 pointer-events를 잃고 사이드바·레일은 계속
 * 살아 있으므로 focus trap도 inert도 걸지 않는다 — 모달이 아니다.
 */
export function ExpandedSurfaceLayer() {
  const descriptors = useExpandedSurfaceDescriptors();
  const { instances, focusedInstanceId } = useExpandedSurfaces();
  const t = useT();
  const theaterId = useSyncExternalStore(subscribe, () => getState().activeTheaterId, () => null);
  const theme = useSyncExternalStore(subscribe, () => getState().activeTheme, () => "instrument" as const);
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const capabilities = useMemo(() => createHostCapabilities(), []);

  const gridRef = useRef<HTMLDivElement>(null);
  const [slotWidths, setSlotWidths] = useState<readonly number[]>([]);

  const open = instances.length > 0;

  // 확대 표면이 서 있다는 유일한 교차 모듈 신호. CSS(캔버스 포인터 차단)와
  // 전역 단축키 양보가 이 한 속성을 읽는다.
  useEffect(() => {
    if (!open) return;
    document.body.setAttribute("data-expanded-surface", "true");
    return () => {
      document.body.removeAttribute("data-expanded-surface");
    };
  }, [open]);

  // 실제로 놓인 슬롯 폭을 표면에 통보한다 — 표면은 이 값으로 스스로 열화한다.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const widths = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-slot"))
        .map((slot) => slot.getBoundingClientRect().width);
      setSlotWidths((previous) =>
        previous.length === widths.length && previous.every((value, index) => Math.abs(value - (widths[index] ?? 0)) < 0.5)
          ? previous
          : widths,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const slot of grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-slot")) {
      observer.observe(slot);
    }
    return () => observer.disconnect();
  }, [instances.length]);

  const minWidthFor = useCallback(
    (instance: ExpandedSurfaceInstance): number => {
      const descriptor = descriptors.get(instance.surfaceId);
      const declared = descriptor?.minSlotWidth;
      return typeof declared === "number" && Number.isFinite(declared) && declared > 0
        ? declared
        : DEFAULT_MIN_SLOT_WIDTH;
    },
    [descriptors],
  );

  /**
   * 분할선 드래그. 인접한 두 슬롯 사이에서만 폭을 주고받는다 — 하나를 넓히면 그
   * 오른쪽 이웃만 줄어들고, 나머지 슬롯은 사용자가 맞춰 둔 폭을 그대로 지킨다.
   */
  const beginDivergeDrag = useCallback(
    (dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      const slots = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-slot"));
      const startWidths = slots.map((slot) => slot.getBoundingClientRect().width);
      const startX = event.clientX;
      const leftMin = minWidthFor(instances[dividerIndex]!);
      const rightMin = minWidthFor(instances[dividerIndex + 1]!);
      const leftStart = startWidths[dividerIndex] ?? 0;
      const rightStart = startWidths[dividerIndex + 1] ?? 0;
      const pair = leftStart + rightStart;
      const [leftFloor, rightFloor] = fitMinimums(leftMin, rightMin, pair);

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      target.classList.add("is-dragging");
      document.body.setAttribute("data-expanded-surface-resizing", "true");

      const applyDelta = (delta: number) => {
        const left = Math.max(leftFloor, Math.min(pair - rightFloor, leftStart + delta));
        const next = [...startWidths];
        next[dividerIndex] = left;
        next[dividerIndex + 1] = pair - left;
        setExpandedSurfaceWeights(next);
      };

      const onMove = (moveEvent: PointerEvent) => applyDelta(moveEvent.clientX - startX);
      const onUp = () => {
        target.releasePointerCapture(event.pointerId);
        target.classList.remove("is-dragging");
        document.body.removeAttribute("data-expanded-surface-resizing");
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [instances, minWidthFor],
  );

  const nudgeDivider = useCallback(
    (dividerIndex: number, deltaPx: number) => {
      const grid = gridRef.current;
      if (!grid) return;
      const slots = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-slot"));
      const widths = slots.map((slot) => slot.getBoundingClientRect().width);
      const leftMin = minWidthFor(instances[dividerIndex]!);
      const rightMin = minWidthFor(instances[dividerIndex + 1]!);
      const leftStart = widths[dividerIndex] ?? 0;
      const rightStart = widths[dividerIndex + 1] ?? 0;
      const pair = leftStart + rightStart;
      const [leftFloor, rightFloor] = fitMinimums(leftMin, rightMin, pair);
      const left = Math.max(leftFloor, Math.min(pair - rightFloor, leftStart + deltaPx));
      const next = [...widths];
      next[dividerIndex] = left;
      next[dividerIndex + 1] = pair - left;
      setExpandedSurfaceWeights(next);
    },
    [instances, minWidthFor],
  );

  // Esc는 포커스된 슬롯 하나만 닫는다. 표면 내부의 보조 표면(찾기·오버레이)이 먼저
  // 먹을 기회를 갖도록 버블 단계에서 듣는다 — 슬롯이 stopPropagation으로 가져간다.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        const index = focusedExpandedSurfaceIndex();
        const target = index === -1 ? instances[instances.length - 1] : instances[index];
        if (!target) return;
        event.preventDefault();
        closeExpandedSurface(target.instanceId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [instances, open]);

  if (!open) return null;

  const canvasHost = document.querySelector<HTMLElement>(".operations-canvas");
  // 분할선도 그리드 자식이다 — 슬롯 트랙만 세면 자식 수가 트랙 수를 넘어 다음 줄로
  // 접히고, 나란히 놓으려던 슬롯이 위아래로 쌓인다. 트랙을 슬롯·분할선 순으로 짠다.
  const template = instances
    .map((instance) => `${Math.max(0.0001, instance.weight)}fr`)
    .join(" var(--space-2) ");

  return createPortal(
    <div
      ref={gridRef}
      className="expanded-surface"
      style={{ gridTemplateColumns: template }}
      data-slot-count={instances.length}
      role="region"
      aria-label={t("chrome.expandedSurface.regionAria")}
      // 캔버스의 pan/zoom/생성 제스처가 이 작업면에서 시작한 입력을 집어가지 않게 끊는다.
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {instances.map((instance, index) => {
        const descriptor = descriptors.get(instance.surfaceId);
        const focused = instance.instanceId === focusedInstanceId;
        return (
          <SurfaceSlot
            key={instance.instanceId}
            instance={instance}
            descriptor={descriptor}
            index={index}
            slotCount={instances.length}
            slotWidth={slotWidths[index] ?? 0}
            focused={focused}
            theaterId={theaterId}
            theme={theme}
            language={language}
            capabilities={capabilities}
            isLast={index === instances.length - 1}
            onDividerPointerDown={beginDivergeDrag}
            onDividerNudge={nudgeDivider}
          />
        );
      })}
    </div>,
    canvasHost ?? document.body,
  );
}

function SurfaceSlot({
  instance,
  descriptor,
  index,
  slotCount,
  slotWidth,
  focused,
  theaterId,
  theme,
  language,
  capabilities,
  isLast,
  onDividerPointerDown,
  onDividerNudge,
}: {
  readonly instance: ExpandedSurfaceInstance;
  readonly descriptor: ExpandedSurfaceDescriptor | undefined;
  readonly index: number;
  readonly slotCount: number;
  readonly slotWidth: number;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly theme: ReturnType<typeof getState>["activeTheme"];
  readonly language: ReturnType<typeof resolveConsoleLanguage>;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly isLast: boolean;
  readonly onDividerPointerDown: (dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onDividerNudge: (dividerIndex: number, deltaPx: number) => void;
}) {
  const t = useT();

  const context = useMemo<ExpandedSurfaceContext>(() => ({
    surfaceId: instance.surfaceId,
    instanceId: instance.instanceId,
    params: instance.params,
    slotIndex: index,
    slotCount,
    slotWidth,
    focused,
    theaterId,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
    theme,
    close: () => closeExpandedSurface(instance.instanceId),
    focus: () => focusExpandedSurface(instance.instanceId),
    replaceParams: (next) => replaceExpandedSurfaceParams(instance.instanceId, next),
  }), [capabilities, focused, index, instance, language, slotCount, slotWidth, theaterId, theme]);

  const title = descriptor
    ? resolveLocalizedText(descriptor.title(context), language)
    : instance.surfaceId;

  return (
    <>
      <section
        className={`expanded-surface-slot${focused ? " is-focused" : ""}`}
        aria-label={title}
        onPointerDownCapture={() => focusExpandedSurface(instance.instanceId)}
        onFocusCapture={() => focusExpandedSurface(instance.instanceId)}
      >
        <header className="expanded-surface-slot-head">
          <span className="expanded-surface-slot-title">{title}</span>
          {descriptor?.tools ? (
            <div className="expanded-surface-slot-tools">
              <PluginErrorBoundary>{descriptor.tools(context)}</PluginErrorBoundary>
            </div>
          ) : null}
          <button
            className="expanded-surface-slot-close"
            type="button"
            aria-label={t("chrome.expandedSurface.closeAria")}
            onClick={() => closeExpandedSurface(instance.instanceId)}
          >
            ✕
          </button>
        </header>
        <div className="expanded-surface-slot-body">
          {descriptor?.aside ? (
            <aside className="expanded-surface-slot-aside">
              <PluginErrorBoundary>{descriptor.aside(context)}</PluginErrorBoundary>
            </aside>
          ) : null}
          <div className="expanded-surface-slot-main">
            <PluginErrorBoundary>
              {descriptor ? descriptor.render(context) : <MissingSurface surfaceId={instance.surfaceId} />}
            </PluginErrorBoundary>
          </div>
        </div>
      </section>
      {isLast ? null : (
        <div
          className="expanded-surface-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chrome.expandedSurface.dividerAria")}
          tabIndex={0}
          onPointerDown={(event) => onDividerPointerDown(index, event)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onDividerNudge(index, -KEYBOARD_STEP_PX);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onDividerNudge(index, KEYBOARD_STEP_PX);
            }
          }}
        >
          <span className="expanded-surface-divider-grip" aria-hidden="true" />
        </div>
      )}
    </>
  );
}

/**
 * 표면을 기여하던 플러그인이 사라졌는데 슬롯은 남은 경우. 조용히 빈 칸을 두면
 * 사용자는 콘솔이 깨진 줄 안다 — 무엇이 없어졌는지 말하고 닫을 길을 준다.
 */
function MissingSurface({ surfaceId }: { readonly surfaceId: string }) {
  const t = useT();
  return (
    <div className="expanded-surface-missing">
      <p>{t("chrome.expandedSurface.missing")}</p>
      <code>{surfaceId}</code>
    </div>
  );
}
