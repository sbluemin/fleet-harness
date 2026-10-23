import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { FloatingWidgetArrival, FloatingWidgetArrivalsCapability, FloatingWidgetAwaiting, FloatingWidgetAwaitingsCapability, FloatingWidgetComposerCapability, FloatingWidgetContext, FloatingWidgetDeparture, FloatingWidgetDeparturesCapability, FloatingWidgetDescriptor, FloatingWidgetFleetSignals, FloatingWidgetKeepOutCapability, FloatingWidgetObjectiveRecordsCapability, FloatingWidgetRect, FloatingWidgetSignalsCapability } from "../../../../features/workspace/shared/floating.js";
import { FeatureErrorBoundary } from "@fleet-console/ui/react";

import { prefersReducedMotion } from "./reduced-motion.js";
import { useConsoleLocale } from "../i18n/index.js";
import { resolveObjectiveActivity } from "../../../../features/execution/client/objective-activity.js";
import { getDepartureIds, getIdleArrivalIds, subscribeDeparture, subscribeIdleArrival } from "../../../../features/execution/client/objective-marks.js";
import { createHostCapabilities } from "./feature-capabilities.js";
import { useFeatureRegistry } from "./feature-registry.js";
import { focusObjective, getState, subscribe as subscribeStore } from "./store.js";
import { openNewSessionComposer } from "../../../../features/workspace/client/conversation/new-session-entry.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = useFeatureRegistry();
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
    open: (options) => openNewSessionComposer(typeof options?.draft === "string" ? { draft: options.draft } : undefined),
  }), []);
  // 스토어 갱신만으로는 /objectives 밖(설정 등)에서 아무 일도 보이지 않는다 —
  // pendingObjectiveFocus는 objectiveRecords 페이지가 소비하므로 rail 알림·검색과 같은 순서로 이동을 동반한다.
  const objectiveRecords = useMemo<FloatingWidgetObjectiveRecordsCapability>(() => ({
    focus: (objectiveId) => {
      focusObjective(objectiveId);
      navigate("/objectives");
    },
  }), [navigate]);
  const context = useMemo<FloatingWidgetContext>(() => ({
    api: capabilities.api,
    arrivals: arrivals.capability,
    departures: departures.capability,
    awaitings: awaitings.capability,
    keepOut: keepOut.capability,
    composer,
    objectiveRecords,
    signals: signals.capability,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [arrivals, awaitings, capabilities, composer, departures, keepOut, language, objectiveRecords, signals]);

  if (floatingWidgets.length === 0) return null;

  return (
    <div className="floating-widget-layer">
      {floatingWidgets.map((descriptor) => (
        <div key={descriptor.id} className="floating-widget">
          <FeatureErrorBoundary>
            <FloatingWidget descriptor={descriptor} context={context} />
          </FeatureErrorBoundary>
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
    const titlesById = new Map(getState().objectiveRecords.map((objectiveRecord) => [objectiveRecord.id, objectiveRecord.title]));
    const arrivals: FloatingWidgetArrival[] = [];
    for (const objectiveId of getIdleArrivalIds()) {
      const title = titlesById.get(objectiveId);
      if (title !== undefined) arrivals.push({ objectiveId, title });
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
    const titlesById = new Map(getState().objectiveRecords.map((objectiveRecord) => [objectiveRecord.id, objectiveRecord.title]));
    const departures: FloatingWidgetDeparture[] = [];
    for (const objectiveId of getDepartureIds()) {
      const title = titlesById.get(objectiveId);
      if (title !== undefined) departures.push({ objectiveId, title });
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
 * 입력·승인을 기다리는 Objective의 정체를 넘긴다. 집계(signals.awaiting)만으로는 위젯이
 * "누가" 기다리는지 말할 수 없어 알림이 자세 하나로 끝난다 — 도착·출발과 같은 원장 계약이다.
 */
function createManagedAwaitingsCapability(): ManagedAwaitingsCapability {
  const activeSubscriptions = new Set<() => void>();

  const list = (): readonly FloatingWidgetAwaiting[] => {
    const state = getState();
    const awaitings: FloatingWidgetAwaiting[] = [];
    for (const objectiveRecord of state.objectiveRecords) {
      if (resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime) !== "awaiting") continue;
      awaitings.push({ objectiveId: objectiveRecord.id, title: objectiveRecord.title });
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
 * 위젯이 덮으면 안 되는 표면들. 열린 레일 페인(설정 포함), 새 세션 컴포저와 그 위로 자란 '/'·'@' 목록(목록은 컴포저 상자 밖에
 * absolute 로 서므로 따로 잰다), 모달
 * 대화상자의 본문이다. 화면 대부분을 덮는 커튼(취역·제어권 인계)은 제외한다 — 그 안에 서 있을
 * 곳이 없고, 그런 표면은 이미 위젯의 포인터 입력을 막는다(layout.css 계약).
 */
const KEEP_OUT_SELECTOR = [
  ".rail-pane:not(.is-parked)",
  ".new-session-composer",
  ".new-session-deck",
  "[aria-modal=\"true\"]",
  "[role=\"dialog\"]:not([aria-modal=\"true\"]):not(.floating-widget-layer *)",
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
    // 화면을 덮는 커튼은 그 안의 카드가 실제 표면이다 — 자식 중 커튼이 아닌 첫 상자를 쓴다.
    // 스크림이 카드보다 먼저 서는 모달(What's New)에서 첫 자식은 또 하나의 커튼이라 건너뛴다.
    // 커튼 아닌 자식이 없으면(취역·제어권 인계) 부관이 설 곳이 없으므로 넣지 않는다.
    for (const child of Array.from(element.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const cardRect = child.getBoundingClientRect();
      if (cardRect.width <= 0 || cardRect.height <= 0 || isCurtain(cardRect)) continue;
      rects.push(toRect(cardRect));
      break;
    }
  }
  return rects;
}

// 스토어 밖에서 여닫히는 회피 표면(새 세션 컴포저의 '/'·'@' 목록처럼 화면의 로컬 상태로 서는 것)이 바뀌었다고 알릴 구독자.
// 호스트 번들 안에서만 쓰인다 — 플러그인은 이 모듈이 아니라 capability 의 subscribe 를 받는다.
const surfaceListeners = new Set<() => void>();

/**
 * 스토어를 거치지 않고 회피 표면이 열리거나 닫혔다 — 위젯이 주기 재측정(수백 ms)을 기다리지 않고 바로 다시 재게 한다.
 * 기다리면 그사이 부관이 막 열린 목록 위에 그대로 서 있다.
 */
export function notifyKeepOutSurfaceChanged(): void {
  for (const listener of [...surfaceListeners]) listener();
}

function createManagedKeepOutCapability(): ManagedKeepOutCapability {
  const activeSubscriptions = new Set<() => void>();

  const subscribe: FloatingWidgetKeepOutCapability["subscribe"] = (listener) => {
    let active = true;
    // 스토어가 여닫는 표면(검색·대화상자)만 즉시 알린다. 레일 페인은 자기 스토어를
    // 가지므로 여기서 잡히지 않고, 위젯의 주기 재측정이 그 지연을 메운다 — DOM 전체를 관찰하면
    // 위젯 자신의 자세 변화까지 알림이 되어 값보다 비용이 크다.
    const unsubscribeStore = subscribeStore(listener);
    surfaceListeners.add(listener);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      unsubscribeStore();
      surfaceListeners.delete(listener);
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
  for (const objectiveRecord of state.objectiveRecords) {
    const activity = resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime);
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

// 함대 신호는 Objective 스토어와 OS 모션 환경에서 바뀐다.
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
      arrival.objectiveId === right[index]?.objectiveId
      && arrival.title === right[index]?.title
    ));
}
