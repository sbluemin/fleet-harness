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

  it("announces the same operation again after the reader has cleared it", () => {
    const first = selectArrivalAnnouncements(createArrivalSelectionState([]), [arrival("op", "Op")]);
    expect(first.queue).toHaveLength(1);

    // 사용자가 확인하면 그 Operation은 도착 목록에서 빠진다.
    const cleared = selectArrivalAnnouncements(first, []);
    expect(cleared.announcedIds.has("op")).toBe(false);

    const again = selectArrivalAnnouncements(cleared, [arrival("op", "Op")]);
    expect(again.queue.at(-1)?.arrivals.map((item) => item.operationId)).toEqual(["op"]);
    // 두 번째 알림은 첫 번째와 다른 식별자를 가져야 만세와 노출 판정이 다시 걸린다.
    expect(again.queue.at(-1)?.id).not.toBe(first.queue[0]?.id);
  });

  it("keeps a still-pending operation out of a second announcement", () => {
    const first = selectArrivalAnnouncements(createArrivalSelectionState([]), [arrival("op", "Op")]);
    const stillPending = selectArrivalAnnouncements(first, [arrival("op", "Op")]);
    expect(stillPending).toBe(first);
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
