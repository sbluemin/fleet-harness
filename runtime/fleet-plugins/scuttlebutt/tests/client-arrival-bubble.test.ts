import type { FloatingWidgetArrival } from "@fleet-console/sdk/floating";
import { describe, expect, it } from "vitest";

import {
  MAX_ARRIVAL_ANNOUNCEMENTS,
  createArrivalSelectionState,
  dismissArrivalAnnouncement,
  selectArrivalAnnouncements,
} from "../client/arrival-bubble.js";

describe("arrival announcement selector", () => {
  it("treats the mount set as seen and suppresses repeated operation ids", () => {
    const mounted = [arrival("existing", "Existing")];
    const initial = createArrivalSelectionState(mounted);
    const unchanged = selectArrivalAnnouncements(initial, mounted);
    expect(unchanged.queue).toEqual([]);

    const announced = selectArrivalAnnouncements(unchanged, [...mounted, arrival("new", "New")]);
    expect(announced.queue).toHaveLength(1);
    expect(announced.queue[0]?.arrivals.map((item) => item.operationId)).toEqual(["new"]);

    const repeated = selectArrivalAnnouncements(announced, [arrival("new", "New")]);
    expect(repeated.queue).toEqual(announced.queue);
  });

  it("combines simultaneous arrivals into one announcement", () => {
    const selected = selectArrivalAnnouncements(createArrivalSelectionState([]), [
      arrival("one", "One"),
      arrival("two", "Two"),
    ]);
    expect(selected.queue).toHaveLength(1);
    expect(selected.queue[0]?.arrivals).toHaveLength(2);
  });

  it("keeps only the three newest queued announcements", () => {
    let state = createArrivalSelectionState([]);
    for (let index = 0; index < MAX_ARRIVAL_ANNOUNCEMENTS + 2; index += 1) {
      state = selectArrivalAnnouncements(state, [arrival(`operation-${index}`, `${index}`)]);
    }
    expect(state.queue.map((item) => item.arrivals[0]?.operationId)).toEqual([
      "operation-2",
      "operation-3",
      "operation-4",
    ]);
    expect(dismissArrivalAnnouncement(state).queue.map((item) => item.arrivals[0]?.operationId)).toEqual([
      "operation-3",
      "operation-4",
    ]);
  });
});

function arrival(operationId: string, title: string): FloatingWidgetArrival {
  return { operationId, title };
}
