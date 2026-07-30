import { useEffect, useMemo } from "react";
import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
  FloatingWidgetContext,
  FloatingWidgetDeparture,
  FloatingWidgetDeparturesCapability,
  FloatingWidgetDescriptor,
  FloatingWidgetFleetSignals,
  FloatingWidgetSignalsCapability,
} from "@fleet-console/sdk/floating";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { panelMotionSuppressed } from "./canvas/canvas-store.js";
import { subscribe as subscribeGlobalSettings } from "./global-settings-store.js";
import { useConsoleLocale } from "./i18n/index.js";
import { resolveOperationActivity } from "./operation-activity.js";
import { getDepartureIds, subscribeDeparture } from "./operation-departure.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "./operation-idle-arrival.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { getState, subscribe as subscribeStore } from "./store.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = usePluginRegistry();
  const language = useConsoleLocale();
  const capabilities = useMemo(() => createHostCapabilities(), []);
  const arrivals = useMemo(() => createManagedArrivalsCapability(), []);
  const departures = useMemo(() => createManagedDeparturesCapability(), []);
  const signals = useMemo(() => createManagedSignalsCapability(), []);
  useEffect(() => () => arrivals.dispose(), [arrivals]);
  useEffect(() => () => departures.dispose(), [departures]);
  useEffect(() => () => signals.dispose(), [signals]);
  const context = useMemo<FloatingWidgetContext>(() => ({
    api: capabilities.api,
    arrivals: arrivals.capability,
    departures: departures.capability,
    signals: signals.capability,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [arrivals, capabilities, departures, language, signals]);

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
  const idleArrivals = getIdleArrivalIds();
  let running = 0;
  let awaiting = 0;
  for (const operation of state.operations) {
    const activity = resolveOperationActivity(operation, state.operationStatus);
    if (activity === "running") running += 1;
    // 사이드바 STATUS 축과 같은 기준을 쓴다 — 확인하지 않은 도착도 사용자를 기다리는 상태다.
    // 원시 status만 세면 콘솔이 AWAITING이라 표시한 Operation의 절반을 위젯이 놓친다.
    else if (activity === "awaiting" || (activity === "idle" && idleArrivals.has(operation.id))) awaiting += 1;
  }
  return {
    running,
    awaiting,
    disconnected: state.connection === "offline",
    reducedMotion: panelMotionSuppressed(),
  };
}

function signalsEqual(left: FloatingWidgetFleetSignals, right: FloatingWidgetFleetSignals): boolean {
  return left.running === right.running
    && left.awaiting === right.awaiting
    && left.disconnected === right.disconnected
    && left.reducedMotion === right.reducedMotion;
}

// 함대 신호는 서로 다른 세 곳에서 바뀐다 — Operation 스토어, 서버 영속 설정, OS 모션 환경.
// 셋을 한 구독으로 합쳐 위젯이 출처를 알 필요가 없게 한다.
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
    const unsubscribeSettings = subscribeGlobalSettings(notifyIfChanged);
    // 도착 확인 여부는 스토어 밖 채널이라 따로 구독해야 awaiting 집계가 갱신된다.
    const unsubscribeIdleArrival = subscribeIdleArrival(notifyIfChanged);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      motionQuery?.removeEventListener("change", notifyIfChanged);
      unsubscribeStore();
      unsubscribeSettings();
      unsubscribeIdleArrival();
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
