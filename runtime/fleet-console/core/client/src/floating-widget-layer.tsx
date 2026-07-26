import { useEffect, useMemo } from "react";
import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
  FloatingWidgetContext,
  FloatingWidgetDescriptor,
} from "@fleet-console/sdk/floating";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { useConsoleLocale } from "./i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "./operation-idle-arrival.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { getState, subscribe as subscribeStore } from "./store.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = usePluginRegistry();
  const language = useConsoleLocale();
  const capabilities = useMemo(() => createHostCapabilities(), []);
  const arrivals = useMemo(() => createManagedArrivalsCapability(), []);
  useEffect(() => () => arrivals.dispose(), [arrivals]);
  const context = useMemo<FloatingWidgetContext>(() => ({
    api: capabilities.api,
    arrivals: arrivals.capability,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [arrivals, capabilities, language]);

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
