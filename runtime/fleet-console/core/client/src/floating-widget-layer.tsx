import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
  FloatingWidgetAwaiting,
  FloatingWidgetAwaitingsCapability,
  FloatingWidgetComposerCapability,
  FloatingWidgetContext,
  FloatingWidgetDeparture,
  FloatingWidgetDeparturesCapability,
  FloatingWidgetDescriptor,
  FloatingWidgetFleetSignals,
  FloatingWidgetKeepOutCapability,
  FloatingWidgetOperationsCapability,
  FloatingWidgetRect,
  FloatingWidgetSignalsCapability,
} from "@fleet-console/sdk/floating";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { prefersReducedMotion } from "./canvas/canvas-store.js";
import { useConsoleLocale } from "./i18n/index.js";
import { resolveOperationActivity } from "./operation-activity.js";
import { getDepartureIds, getIdleArrivalIds, subscribeDeparture, subscribeIdleArrival } from "./operation-marks.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { focusOperation, getState, openQuickLaunch, openQuickLaunchWithDraft, subscribe as subscribeStore } from "./store.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = usePluginRegistry();
  const language = useConsoleLocale();
  const navigate = useNavigate();
  const capabilities = useMemo(() => createHostCapabilities(), []);
  const arrivals = useMemo(() => createManagedArrivalsCapability(), []);
  const departures = useMemo(() => createManagedDeparturesCapability(), []);
  const awaitings = useMemo(() => createManagedAwaitingsCapability(), []);
  const keepOut = useMemo(() => createManagedKeepOutCapability(), []);
  const signals = useMemo(() => createManagedSignalsCapability(), []);
  useEffect(() => () => arrivals.dispose(), [arrivals]);
  useEffect(() => () => departures.dispose(), [departures]);
  useEffect(() => () => awaitings.dispose(), [awaitings]);
  useEffect(() => () => keepOut.dispose(), [keepOut]);
  useEffect(() => () => signals.dispose(), [signals]);
  const composer = useMemo<FloatingWidgetComposerCapability>(() => ({
    open: (options) => {
      if (typeof options?.draft === "string") openQuickLaunchWithDraft(options.draft);
      else openQuickLaunch();
    },
  }), []);
  // 스토어 갱신만으로는 /operations 밖(설정 등)에서 아무 일도 보이지 않는다 —
  // pendingOperationFocus는 operations 페이지가 소비하므로 rail 알림·검색과 같은 순서로 이동을 동반한다.
  const operations = useMemo<FloatingWidgetOperationsCapability>(() => ({
    focus: (operationId) => {
      focusOperation(operationId);
      navigate("/operations");
    },
  }), [navigate]);
  const context = useMemo<FloatingWidgetContext>(() => ({
    api: capabilities.api,
    arrivals: arrivals.capability,
    departures: departures.capability,
    awaitings: awaitings.capability,
    keepOut: keepOut.capability,
    composer,
    operations,
    signals: signals.capability,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [arrivals, awaitings, capabilities, composer, departures, keepOut, language, operations, signals]);

  if (floatingWidgets.length === 0) return null;

  return (
    <div className="floating-widget-layer">
      {floatingWidgets.map((descriptor) => (
        <div key={descriptor.id} className="floating-widget">
          <PluginErrorBoundary>
            <FloatingWidget descriptor={descriptor} context={context} />
          </PluginErrorBoundary>
        </div>
      ))}
    </div>
  );
}

function FloatingWidget({ descriptor, context }: {
  readonly descriptor: FloatingWidgetDescriptor;
  readonly context: FloatingWidgetContext;
}) {
  return <>{descriptor.render(context)}</>;
}

interface ManagedArrivalsCapability {
  readonly capability: FloatingWidgetArrivalsCapability;
  readonly dispose: () => void;
}

function createManagedArrivalsCapability(): ManagedArrivalsCapability {
  const activeSubscriptions = new Set<() => void>();

  const list = (): readonly FloatingWidgetArrival[] => {
    const titlesById = new Map(getState().operations.map((operation) => [operation.id, operation.title]));
    const arrivals: FloatingWidgetArrival[] = [];
    for (const operationId of getIdleArrivalIds()) {
      const title = titlesById.get(operationId);
      if (title !== undefined) arrivals.push({ operationId, title });
    }
    return arrivals;
  };

  const subscribe: FloatingWidgetArrivalsCapability["subscribe"] = (listener) => {
    let previous = list();
    let active = true;

    const notifyIfChanged = () => {
      const next = list();
      if (arrivalsEqual(previous, next)) return;
      previous = next;
      listener(next);
    };

    const unsubscribeIdleArrival = subscribeIdleArrival(notifyIfChanged);
    const unsubscribeStore = subscribeStore(notifyIfChanged);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      unsubscribeIdleArrival();
      unsubscribeStore();
      activeSubscriptions.delete(unsubscribe);
    };

    activeSubscriptions.add(unsubscribe);
    try {
      listener(previous);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  };

  return {
    capability: { list, subscribe },
    dispose: () => {
      for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
    },
  };
}

interface ManagedDeparturesCapability {
  readonly capability: FloatingWidgetDeparturesCapability;
  readonly dispose: () => void;
}

function createManagedDeparturesCapability(): ManagedDeparturesCapability {
  const activeSubscriptions = new Set<() => void>();

  const list = (): readonly FloatingWidgetDeparture[] => {
    const titlesById = new Map(getState().operations.map((operation) => [operation.id, operation.title]));
    const departures: FloatingWidgetDeparture[] = [];
    for (const operationId of getDepartureIds()) {
      const title = titlesById.get(operationId);
      if (title !== undefined) departures.push({ operationId, title });
    }
    return departures;
  };

  const subscribe: FloatingWidgetDeparturesCapability["subscribe"] = (listener) => {
    let previous = list();
    let active = true;

    const notifyIfChanged = () => {
      const next = list();
      if (arrivalsEqual(previous, next)) return;
      previous = next;
      listener(next);
    };

    const unsubscribeDeparture = subscribeDeparture(notifyIfChanged);
    const unsubscribeStore = subscribeStore(notifyIfChanged);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      unsubscribeDeparture();
      unsubscribeStore();
      activeSubscriptions.delete(unsubscribe);
    };

    activeSubscriptions.add(unsubscribe);
    try {
      listener(previous);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  };

  return {
    capability: { list, subscribe },
    dispose: () => {
      for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
    },
  };
}

interface ManagedAwaitingsCapability {
  readonly capability: FloatingWidgetAwaitingsCapability;
  readonly dispose: () => void;
}

/**
 * 입력·승인을 기다리는 Operation의 정체를 넘긴다. 집계(signals.awaiting)만으로는 위젯이
 * "누가" 기다리는지 말할 수 없어 알림이 자세 하나로 끝난다 — 도착·출발과 같은 원장 계약이다.
 */
function createManagedAwaitingsCapability(): ManagedAwaitingsCapability {
  const activeSubscriptions = new Set<() => void>();

  const list = (): readonly FloatingWidgetAwaiting[] => {
    const state = getState();
    const awaitings: FloatingWidgetAwaiting[] = [];
    for (const operation of state.operations) {
      if (resolveOperationActivity(operation, state.operationRuntime) !== "awaiting") continue;
      awaitings.push({ operationId: operation.id, title: operation.title });
    }
    return awaitings;
  };

  const subscribe: FloatingWidgetAwaitingsCapability["subscribe"] = (listener) => {
    let previous = list();
    let active = true;
    const notifyIfChanged = () => {
      const next = list();
      if (arrivalsEqual(previous, next)) return;
      previous = next;
      listener(next);
    };
    const unsubscribeStore = subscribeStore(notifyIfChanged);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      unsubscribeStore();
      activeSubscriptions.delete(unsubscribe);
    };
    activeSubscriptions.add(unsubscribe);
    try {
      listener(previous);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  };

  return {
    capability: { list, subscribe },
    dispose: () => {
      for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
    },
  };
}

interface ManagedKeepOutCapability {
  readonly capability: FloatingWidgetKeepOutCapability;
  readonly dispose: () => void;
}

/**
 * 위젯이 덮으면 안 되는 표면들. 열린 레일 페인(설정 포함), Quick Launch 카드와 그 덱, 모달
 * 대화상자의 본문이다. 화면 대부분을 덮는 커튼(취역·제어권 인계)은 제외한다 — 그 안에 서 있을
 * 곳이 없고, 그런 표면은 이미 위젯의 포인터 입력을 막는다(layout.css 계약).
 */
const KEEP_OUT_SELECTOR = [
  ".rail-pane:not(.is-parked)",
  ".quick-launch-card",
  ".quick-launch-overlay [role=\"listbox\"]",
  "[aria-modal=\"true\"]",
  "[role=\"dialog\"]:not([aria-modal=\"true\"]):not(.quick-launch-overlay):not(.floating-widget-layer *)",
].join(", ");
const KEEP_OUT_CURTAIN_FRACTION = 0.85;

function toRect(rect: DOMRect): FloatingWidgetRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function readKeepOutRects(): readonly FloatingWidgetRect[] {
  if (typeof document === "undefined") return [];
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const isCurtain = (rect: DOMRect) => (rect.width * rect.height) / viewportArea >= KEEP_OUT_CURTAIN_FRACTION;
  const rects: FloatingWidgetRect[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(KEEP_OUT_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!isCurtain(rect)) {
      rects.push(toRect(rect));
      continue;
    }
    // 화면을 덮는 커튼은 그 안의 카드가 실제 표면이다 — 첫 자식 요소의 상자를 쓴다. 그것마저
    // 커튼이면(취역·제어권 인계) 부관이 설 곳이 없으므로 넣지 않는다.
    const card = element.firstElementChild;
    if (!(card instanceof HTMLElement)) continue;
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width <= 0 || cardRect.height <= 0 || isCurtain(cardRect)) continue;
    rects.push(toRect(cardRect));
  }
  return rects;
}

function createManagedKeepOutCapability(): ManagedKeepOutCapability {
  const activeSubscriptions = new Set<() => void>();

  const subscribe: FloatingWidgetKeepOutCapability["subscribe"] = (listener) => {
    let active = true;
    // 스토어가 여닫는 표면(Quick Launch·검색·대화상자)만 즉시 알린다. 레일 페인은 자기 스토어를
    // 가지므로 여기서 잡히지 않고, 위젯의 주기 재측정이 그 지연을 메운다 — DOM 전체를 관찰하면
    // 위젯 자신의 자세 변화까지 알림이 되어 값보다 비용이 크다.
    const unsubscribeStore = subscribeStore(listener);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      unsubscribeStore();
      activeSubscriptions.delete(unsubscribe);
    };
    activeSubscriptions.add(unsubscribe);
    return unsubscribe;
  };

  return {
    capability: { list: readKeepOutRects, subscribe },
    dispose: () => {
      for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
    },
  };
}

interface ManagedSignalsCapability {
  readonly capability: FloatingWidgetSignalsCapability;
  readonly dispose: () => void;
}

function readFleetSignals(): FloatingWidgetFleetSignals {
  const state = getState();
  let running = 0;
  let awaiting = 0;
  for (const operation of state.operations) {
    const activity = resolveOperationActivity(operation, state.operationRuntime);
    if (activity === "running") running += 1;
    // 확인하지 않은 완료 도착은 arrivals 채널과 만세 연출이 맡는다.
    // 사이드바 STATUS 축처럼 awaiting에 섞으면 보리가 경보 포즈에 남아 idle로 돌아가지 않는다.
    else if (activity === "awaiting") awaiting += 1;
  }
  return {
    running,
    awaiting,
    disconnected: state.connection === "offline",
    reducedMotion: prefersReducedMotion(),
  };
}

function signalsEqual(left: FloatingWidgetFleetSignals, right: FloatingWidgetFleetSignals): boolean {
  return left.running === right.running
    && left.awaiting === right.awaiting
    && left.disconnected === right.disconnected
    && left.reducedMotion === right.reducedMotion;
}

// 함대 신호는 Operation 스토어와 OS 모션 환경에서 바뀐다.
// 완료 도착은 arrivals 채널이 따로 전하므로 여기 집계에 섞지 않는다.
function createManagedSignalsCapability(): ManagedSignalsCapability {
  const activeSubscriptions = new Set<() => void>();

  const subscribe: FloatingWidgetSignalsCapability["subscribe"] = (listener) => {
    let previous = readFleetSignals();
    let active = true;

    const notifyIfChanged = () => {
      const next = readFleetSignals();
      if (signalsEqual(previous, next)) return;
      previous = next;
      listener(next);
    };

    const motionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    motionQuery?.addEventListener("change", notifyIfChanged);
    const unsubscribeStore = subscribeStore(notifyIfChanged);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      motionQuery?.removeEventListener("change", notifyIfChanged);
      unsubscribeStore();
      activeSubscriptions.delete(unsubscribe);
    };

    activeSubscriptions.add(unsubscribe);
    try {
      listener(previous);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  };

  return {
    capability: { read: readFleetSignals, subscribe },
    dispose: () => {
      for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
    },
  };
}

function arrivalsEqual(
  left: readonly FloatingWidgetArrival[],
  right: readonly FloatingWidgetArrival[],
): boolean {
  return left.length === right.length
    && left.every((arrival, index) => (
      arrival.operationId === right[index]?.operationId
      && arrival.title === right[index]?.title
    ));
}
