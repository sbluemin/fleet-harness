import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
  FloatingWidgetContext,
  FloatingWidgetDeparture,
  FloatingWidgetDeparturesCapability,
  FloatingWidgetDescriptor,
  FloatingWidgetFleetSignals,
  FloatingWidgetOperationsCapability,
  FloatingWidgetSignalsCapability,
} from "@fleet-console/sdk/floating";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { prefersReducedMotion } from "./canvas/canvas-store.js";
import { useConsoleLocale } from "./i18n/index.js";
import { resolveOperationActivity } from "./operation-activity.js";
import { getDepartureIds, subscribeDeparture } from "./operation-departure.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "./operation-idle-arrival.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { focusOperation, getState, subscribe as subscribeStore } from "./store.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = usePluginRegistry();
  const language = useConsoleLocale();
  const navigate = useNavigate();
  const capabilities = useMemo(() => createHostCapabilities(), []);
  const arrivals = useMemo(() => createManagedArrivalsCapability(), []);
  const departures = useMemo(() => createManagedDeparturesCapability(), []);
  const signals = useMemo(() => createManagedSignalsCapability(), []);
  useEffect(() => () => arrivals.dispose(), [arrivals]);
  useEffect(() => () => departures.dispose(), [departures]);
  useEffect(() => () => signals.dispose(), [signals]);
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
    operations,
    signals: signals.capability,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [arrivals, capabilities, departures, language, operations, signals]);

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
