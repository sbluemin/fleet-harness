import type {
  FloatingWidgetDeparture,
} from "@fleet-console/sdk/floating";
import { describe, expect, it } from "vitest";

import {
  MAX_DEPARTURE_ANNOUNCEMENTS,
  createDepartureSelectionState,
  dismissDepartureAnnouncement,
  placeDepartureBubble,
  selectDepartureAnnouncements,
} from "../client/departure-bubble.js";

describe("departure announcement selector", () => {
  it("treats the mount ledger as consumed and announces only new departures", () => {
    const mounted = [departure("existing", "Existing")];
    const initial = createDepartureSelectionState(mounted);
    expect(selectDepartureAnnouncements(initial, mounted).queue).toEqual([]);

    const selected = selectDepartureAnnouncements(initial, [
      ...mounted,
      departure("new", "New"),
    ]);
    expect(selected.queue[0]?.arrivals.map((item) => item.operationId)).toEqual(["new"]);
  });

  it("consumes a cooldown-held id once and allows it again only after the ledger clears it", () => {
    const first = selectDepartureAnnouncements(
      createDepartureSelectionState([]),
      [departure("operation", "Operation")],
    );
    const held = selectDepartureAnnouncements(first, [departure("operation", "Operation")]);
    expect(held).toBe(first);

    const cleared = selectDepartureAnnouncements(held, []);
    const restarted = selectDepartureAnnouncements(cleared, [departure("operation", "Operation")]);
    expect(restarted.queue.at(-1)?.arrivals.map((item) => item.operationId)).toEqual(["operation"]);
    expect(restarted.queue.at(-1)?.id).not.toBe(first.queue[0]?.id);
  });

  it("keeps the three newest queued announcements and dismisses the oldest", () => {
    let state = createDepartureSelectionState([]);
    for (let index = 0; index < MAX_DEPARTURE_ANNOUNCEMENTS + 2; index += 1) {
      state = selectDepartureAnnouncements(state, [
        departure(`operation-${index}`, `Operation ${index}`),
      ]);
    }

    expect(state.queue.map((item) => item.arrivals[0]?.operationId)).toEqual([
      "operation-2",
      "operation-3",
      "operation-4",
    ]);
    expect(dismissDepartureAnnouncement(state).queue.map((item) => (
      item.arrivals[0]?.operationId
    ))).toEqual(["operation-3", "operation-4"]);
  });
});

describe("DepartureBubble placement", () => {
  it("uses the arrival rect as a read-only anchor below the mascot", () => {
    const bubbleStyle: Record<string, string> = {};
    const protectedStyle = new Proxy({ visibility: "visible" }, {
      set: () => {
        throw new Error("placement must not write another element");
      },
    });
    const bubble = element(bubbleStyle, domRect({
      left: 100,
      right: 300,
      top: 0,
      bottom: 40,
      width: 200,
      height: 40,
    }));
    const mascot = element(protectedStyle, domRect({
      left: 100,
      right: 184,
      top: 100,
      bottom: 150,
      width: 84,
      height: 50,
    }));
    const arrival = element(protectedStyle, domRect({
      left: 100,
      right: 300,
      top: 180,
      bottom: 240,
      width: 200,
      height: 60,
    }));

    expect(() => placeDepartureBubble({
      bubble,
      mascot,
      arrival,
      viewportWidth: 1_000,
      viewportHeight: 800,
    })).not.toThrow();
    expect(bubbleStyle.top).toBe("248px");
  });
});

function departure(operationId: string, title: string): FloatingWidgetDeparture {
  return { operationId, title };
}

function domRect(values: {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    ...values,
    x: values.left,
    y: values.top,
    toJSON: () => values,
  };
}

function element(
  style: Record<string, string>,
  rect: DOMRect,
): HTMLButtonElement {
  return {
    style,
    getBoundingClientRect: () => rect,
  } as unknown as HTMLButtonElement;
}
