import { describe, expect, it } from "vitest";

import { createPluginTerminalTicketRegistry } from "../server/shared/tickets.js";

describe("terminal ticket invalidateForSession", () => {
  it("drops outstanding tickets for the target session only", () => {
    const tickets = createPluginTerminalTicketRegistry({
      now: () => 1_000,
      randomTicket: (() => {
        let index = 0;
        return () => `ticket-${index++}`;
      })(),
    });
    const keep = tickets.issue({ cwd: "/a", sessionId: "keep" });
    const dropA = tickets.issue({ cwd: "/b", sessionId: "drop" });
    const dropB = tickets.issue({ cwd: "/b", sessionId: "drop" });

    tickets.invalidateForSession("drop");

    expect(tickets.consume(dropA.ticket)).toBeNull();
    expect(tickets.consume(dropB.ticket)).toBeNull();
    expect(tickets.consume(keep.ticket)).toMatchObject({ sessionId: "keep" });
  });
});
