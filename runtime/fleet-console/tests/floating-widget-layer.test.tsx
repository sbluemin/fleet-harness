// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FloatingWidgetArrival,
  FloatingWidgetContext,
  FloatingWidgetDeparture,
  FloatingWidgetDescriptor,
} from "@fleet-console/sdk/floating";
import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import {
  markIdleArrival,
  resetIdleArrivalForTests,
} from "../core/client/src/operation-marks.js";
import {
  markDeparture,
  resetDepartureForTests,
} from "../core/client/src/operation-marks.js";
import { getState, setState } from "../core/client/src/store.js";
import type { OperationNode } from "../core/client/src/types.js";

let floatingWidgets: readonly FloatingWidgetDescriptor[] = [];

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({ floatingWidgets , expandedSurfaces: [], persistentComponents: []}),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let FloatingWidgetLayer: typeof import("../core/client/src/floating-widget-layer.js").FloatingWidgetLayer;

beforeAll(async () => {
  ({ FloatingWidgetLayer } = await import("../core/client/src/floating-widget-layer.js"));
});

beforeEach(() => {
  resetIdleArrivalForTests();
  resetDepartureForTests();
  setState({ operations: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetIdleArrivalForTests();
  resetDepartureForTests();
  setState({ operations: [] });
  document.body.replaceChildren();
  floatingWidgets = [];
  vi.restoreAllMocks();
});

describe("FloatingWidgetLayer", () => {
  it("renders a plugin contribution with its registry identity", () => {
    const plugin: FleetClientPlugin = {
      id: "demo",
      floatingWidgets: [{
        id: "mascot",
        render: (context) => createElement("button", {
          type: "button",
          "data-language": context.language,
        }, "Admiral Sam"),
      }],
    };

    renderLayer([plugin]);

    const layer = container.querySelector(".floating-widget-layer");
    expect(layer?.querySelector(".floating-widget")?.textContent).toBe("Admiral Sam");
    expect(floatingWidgets[0]?.id).toBe("demo:mascot");
  });

  it("is absent when no plugin contributes a widget", () => {
    renderLayer([]);

    expect(container.querySelector(".floating-widget-layer")).toBeNull();
  });

  it("isolates a throwing widget from the rest of the shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin: FleetClientPlugin = {
      id: "broken",
      floatingWidgets: [{
        id: "widget",
        render: () => {
          throw new Error("widget failed");
        },
      }],
    };

    expect(() => renderLayer([plugin])).not.toThrow();
    expect(container.querySelector(".floating-widget-layer")).not.toBeNull();
    expect(container.querySelector(".floating-widget")?.textContent).toBe("Plugin failed to render.");
  });

  it("delivers titled arrivals immediately, updates them, and unsubscribes on unmount", () => {
    const received: (readonly FloatingWidgetArrival[])[] = [];
    setState({
      operations: [
        operation("alpha", "Alpha launch"),
        operation("bravo", "Bravo finish"),
        operation("charlie", "Charlie follow-up"),
      ],
    });
    markIdleArrival("alpha");

    const plugin: FleetClientPlugin = {
      id: "arrivals",
      floatingWidgets: [{
        id: "observer",
        render: (context) => {
          useEffect(
            () => context.arrivals.subscribe((arrivals) => received.push(arrivals)),
            [context.arrivals],
          );
          return createElement("span", null, "Arrival observer");
        },
      }],
    };

    renderLayer([plugin]);

    expect(received).toEqual([
      [{ operationId: "alpha", title: "Alpha launch" }],
    ]);

    act(() => markIdleArrival("bravo"));

    expect(received.at(-1)).toEqual([
      { operationId: "alpha", title: "Alpha launch" },
      { operationId: "bravo", title: "Bravo finish" },
    ]);

    renderLayer([]);
    const updateCountAfterUnmount = received.length;
    act(() => markIdleArrival("charlie"));

    expect(received).toHaveLength(updateCountAfterUnmount);
  });

  it("wires context.operations.focus to the store focus action and the operations route", () => {
    setState({
      operations: [
        operation("alpha", "Alpha launch"),
        operation("bravo", "Bravo finish"),
      ],
    });
    let captured: FloatingWidgetContext | null = null;
    const plugin: FleetClientPlugin = {
      id: "operations",
      floatingWidgets: [{
        id: "probe",
        render: (context) => {
          captured = context;
          return null;
        },
      }],
    };

    renderLayer([plugin]);
    expect(captured?.operations).toBeDefined();

    act(() => captured!.operations.focus("bravo"));

    const state = getState();
    expect(state.activeTheaterId).toBe("theater");
    expect(state.activeOperationId).toBe("bravo");
    expect(state.pendingOperationFocus).toBe("bravo");
    // /operations 밖에서 눌러도 포커스가 보이려면 라우트 이동이 동반되어야 한다.
    expect(lastPathname).toBe("/operations");
  });

  it("delivers titled departures immediately, updates them, and unsubscribes on unmount", () => {
    const received: (readonly FloatingWidgetDeparture[])[] = [];
    setState({
      operations: [
        operation("alpha", "Alpha launch"),
        operation("bravo", "Bravo start"),
        operation("charlie", "Charlie follow-up"),
      ],
    });
    markDeparture("alpha");

    const plugin: FleetClientPlugin = {
      id: "departures",
      floatingWidgets: [{
        id: "observer",
        render: (context) => {
          useEffect(
            () => context.departures.subscribe((departures) => received.push(departures)),
            [context.departures],
          );
          return createElement("span", null, "Departure observer");
        },
      }],
    };

    renderLayer([plugin]);

    expect(received).toEqual([
      [{ operationId: "alpha", title: "Alpha launch" }],
    ]);

    act(() => markDeparture("bravo"));

    expect(received.at(-1)).toEqual([
      { operationId: "alpha", title: "Alpha launch" },
      { operationId: "bravo", title: "Bravo start" },
    ]);

    renderLayer([]);
    const updateCountAfterUnmount = received.length;
    act(() => markDeparture("charlie"));

    expect(received).toHaveLength(updateCountAfterUnmount);
  });

  it("keeps idle arrivals out of awaiting so Bori can leave the alert pose", () => {
    const received: Array<{ awaiting: number; running: number }> = [];
    setState({
      operations: [
        operation("idle-done", "Idle done"),
        operation("waiting", "Waiting"),
      ],
      operationRuntime: {
        waiting: { lifecycle: "live", activity: "awaiting" },
      },
    });
    markIdleArrival("idle-done");

    const plugin: FleetClientPlugin = {
      id: "signals",
      floatingWidgets: [{
        id: "observer",
        render: (context) => {
          useEffect(
            () => context.signals.subscribe((signals) => {
              received.push({ awaiting: signals.awaiting, running: signals.running });
            }),
            [context.signals],
          );
          return createElement("span", null, "Signal observer");
        },
      }],
    };

    renderLayer([plugin]);

    expect(received.at(-1)).toEqual({ awaiting: 1, running: 0 });

    act(() => markIdleArrival("waiting"));

    expect(received.at(-1)).toEqual({ awaiting: 1, running: 0 });
  });

  it("counts a finished idle arrival as zero awaiting", () => {
    const received: number[] = [];
    setState({ operations: [operation("idle-done", "Idle done")] });
    markIdleArrival("idle-done");

    const plugin: FleetClientPlugin = {
      id: "signals-idle",
      floatingWidgets: [{
        id: "observer",
        render: (context) => {
          useEffect(
            () => context.signals.subscribe((signals) => {
              received.push(signals.awaiting);
            }),
            [context.signals],
          );
          return createElement("span", null, "Idle signal observer");
        },
      }],
    };

    renderLayer([plugin]);

    expect(received.at(-1)).toBe(0);
  });
});

let lastPathname = "";

function LocationProbe() {
  lastPathname = useLocation().pathname;
  return null;
}

function renderLayer(plugins: readonly FleetClientPlugin[]): void {
  floatingWidgets = plugins.flatMap((plugin) => (plugin.floatingWidgets ?? []).map((descriptor) => ({
    ...descriptor,
    id: `${plugin.id}:${descriptor.id}`,
  })));
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/settings"]}>
        <LocationProbe />
        <FloatingWidgetLayer />
      </MemoryRouter>,
    );
  });
}

function operation(id: string, title: string): OperationNode {
  return {
    id,
    theaterId: "theater",
    type: "test",
    pluginId: "test",
    title,
    payload: {},
    geometry: null,
    ts: {
      createdAt: 1,
      updatedAt: 1,
    },
  };
}
