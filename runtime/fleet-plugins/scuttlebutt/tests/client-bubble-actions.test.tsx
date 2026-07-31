// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
  FloatingWidgetDeparture,
  FloatingWidgetDeparturesCapability,
  FloatingWidgetOperationsCapability,
} from "@fleet-console/sdk/floating";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArrivalBubble } from "../client/arrival-bubble.js";
import { DepartureBubble } from "../client/departure-bubble.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let mascot: HTMLButtonElement;
let mascotRef: { current: HTMLButtonElement | null };
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  mascot = document.createElement("button");
  document.body.append(mascot);
  mascotRef = { current: mascot };
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ArrivalBubble operation deep link", () => {
  it("focuses the operation and dismisses the bubble when the body action is clicked", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([arrival("op-1", "Build finished")]));

    const open = container.querySelector<HTMLButtonElement>(".scuttlebutt-arrival-open");
    expect(open?.textContent).toBe("Build finished");
    expect(container.querySelector(".scuttlebutt-arrival-label")?.textContent).toBe("Finished");

    act(() => open?.click());

    expect(operations.focused).toEqual(["op-1"]);
    expect(container.querySelector(".scuttlebutt-arrival-bubble")).toBeNull();
  });

  it("dismisses without focusing when the close action is clicked", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([arrival("op-1", "Build finished")]));

    const dismiss = container.querySelector<HTMLButtonElement>(".scuttlebutt-arrival-dismiss");
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss");
    act(() => dismiss?.click());

    expect(operations.focused).toEqual([]);
    expect(container.querySelector(".scuttlebutt-arrival-bubble")).toBeNull();
  });

  it("expands simultaneous arrivals into one focusable row per operation", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([
      arrival("op-1", "First"),
      arrival("op-2", "Second"),
    ]));

    const rows = [...container.querySelectorAll<HTMLButtonElement>(".scuttlebutt-arrival-open")];
    expect(rows.map((row) => row.textContent)).toEqual(["First", "Second"]);

    act(() => rows[1]?.click());

    expect(operations.focused).toEqual(["op-2"]);
    expect(container.querySelector(".scuttlebutt-arrival-bubble")).toBeNull();
  });

  it("dismisses the visible bubble on Escape", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([arrival("op-1", "Build finished")]));
    expect(container.querySelector(".scuttlebutt-arrival-bubble")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(operations.focused).toEqual([]);
    expect(container.querySelector(".scuttlebutt-arrival-bubble")).toBeNull();
  });

  it("keeps the bubble when Escape was already handled by a foreground surface", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([arrival("op-1", "Build finished")]));

    act(() => {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      event.preventDefault();
      window.dispatchEvent(event);
    });

    expect(container.querySelector(".scuttlebutt-arrival-bubble")).not.toBeNull();
  });

  it("keeps the bubble while a modal owns input", () => {
    const arrivals = createArrivals([]);
    const operations = createOperations();

    renderArrival(arrivals.capability, operations);
    act(() => arrivals.push([arrival("op-1", "Build finished")]));

    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    modal.remove();

    expect(container.querySelector(".scuttlebutt-arrival-bubble")).not.toBeNull();
  });

  it("keeps the departure bubble when Escape was already handled", () => {
    const departures = createDepartures([]);
    const operations = createOperations();

    renderDeparture(departures.capability, operations);
    act(() => departures.push([departure("op-9", "Deploy started")]));

    act(() => {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      event.preventDefault();
      window.dispatchEvent(event);
    });

    expect(container.querySelector(".scuttlebutt-departure-bubble")).not.toBeNull();
  });
});

describe("DepartureBubble operation deep link", () => {
  it("focuses the operation and dismisses the bubble when the body action is clicked", () => {
    const departures = createDepartures([]);
    const operations = createOperations();

    renderDeparture(departures.capability, operations);
    act(() => departures.push([departure("op-9", "Deploy started")]));

    const open = container.querySelector<HTMLButtonElement>(".scuttlebutt-departure-open");
    expect(open?.textContent).toBe("Deploy started");
    expect(container.querySelector(".scuttlebutt-departure-label")?.textContent).toBe("Started");

    act(() => open?.click());

    expect(operations.focused).toEqual(["op-9"]);
    expect(container.querySelector(".scuttlebutt-departure-bubble")).toBeNull();
  });

  it("dismisses without focusing when the close action is clicked", () => {
    const departures = createDepartures([]);
    const operations = createOperations();

    renderDeparture(departures.capability, operations);
    act(() => departures.push([departure("op-9", "Deploy started")]));

    act(() => container.querySelector<HTMLButtonElement>(".scuttlebutt-departure-dismiss")?.click());

    expect(operations.focused).toEqual([]);
    expect(container.querySelector(".scuttlebutt-departure-bubble")).toBeNull();
  });

  it("expands simultaneous departures into one focusable row per operation", () => {
    const departures = createDepartures([]);
    const operations = createOperations();

    renderDeparture(departures.capability, operations);
    act(() => departures.push([
      departure("op-8", "Earlier"),
      departure("op-9", "Later"),
    ]));

    const rows = [...container.querySelectorAll<HTMLButtonElement>(".scuttlebutt-departure-open")];
    expect(rows.map((row) => row.textContent)).toEqual(["Earlier", "Later"]);

    act(() => rows[0]?.click());

    expect(operations.focused).toEqual(["op-8"]);
    expect(container.querySelector(".scuttlebutt-departure-bubble")).toBeNull();
  });
});

function renderArrival(
  arrivals: FloatingWidgetArrivalsCapability,
  operations: FloatingWidgetOperationsCapability,
): void {
  act(() => {
    root.render(
      <ArrivalBubble
        arrivals={arrivals}
        operations={operations}
        mascot={mascotRef}
        quiet={true}
        positionRevision={0}
        onShow={() => {}}
      />,
    );
  });
}

function renderDeparture(
  departures: FloatingWidgetDeparturesCapability,
  operations: FloatingWidgetOperationsCapability,
): void {
  act(() => {
    root.render(
      <DepartureBubble
        departures={departures}
        operations={operations}
        mascot={mascotRef}
        quiet={true}
        positionRevision={0}
        onShow={() => {}}
      />,
    );
  });
}

function createOperations(): FloatingWidgetOperationsCapability & { focused: string[] } {
  const focused: string[] = [];
  return {
    focused,
    focus: (operationId) => {
      focused.push(operationId);
    },
  };
}

function arrival(operationId: string, title: string): FloatingWidgetArrival {
  return { operationId, title };
}

function departure(operationId: string, title: string): FloatingWidgetDeparture {
  return { operationId, title };
}

function createArrivals(initial: readonly FloatingWidgetArrival[]): {
  capability: FloatingWidgetArrivalsCapability;
  push: (next: readonly FloatingWidgetArrival[]) => void;
} {
  let current = initial;
  const listeners = new Set<(arrivals: readonly FloatingWidgetArrival[]) => void>();
  return {
    capability: {
      list: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
      },
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createDepartures(initial: readonly FloatingWidgetDeparture[]): {
  capability: FloatingWidgetDeparturesCapability;
  push: (next: readonly FloatingWidgetDeparture[]) => void;
} {
  let current = initial;
  const listeners = new Set<(departures: readonly FloatingWidgetDeparture[]) => void>();
  return {
    capability: {
      list: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
      },
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}
