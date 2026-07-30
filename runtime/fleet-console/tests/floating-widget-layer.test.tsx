// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FloatingWidgetArrival,
  FloatingWidgetDeparture,
  FloatingWidgetDescriptor,
} from "@fleet-console/sdk/floating";
import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import {
  markIdleArrival,
  resetIdleArrivalForTests,
} from "../core/client/src/operation-idle-arrival.js";
import {
  markDeparture,
  resetDepartureForTests,
} from "../core/client/src/operation-departure.js";
import { setState } from "../core/client/src/store.js";
import type { OperationNode } from "../core/client/src/types.js";

let floatingWidgets: readonly FloatingWidgetDescriptor[] = [];

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({ floatingWidgets }),
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
});

function renderLayer(plugins: readonly FleetClientPlugin[]): void {
  floatingWidgets = plugins.flatMap((plugin) => (plugin.floatingWidgets ?? []).map((descriptor) => ({
    ...descriptor,
    id: `${plugin.id}:${descriptor.id}`,
  })));
  act(() => {
    root.render(<FloatingWidgetLayer />);
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
