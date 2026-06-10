import { describe, expect, it } from "vitest";

import { createGatewayCallQueue } from "../src/call-queue.js";

describe("gateway call queue", () => {
  it("delivers calls in FIFO order and resolves by call id", async () => {
    const queue = createGatewayCallQueue({ timeoutMs: 10_000 });
    const first = queue.enqueue("session", "a", "tool", {});
    const second = queue.enqueue("session", "b", "tool", {});

    expect(queue.next("session")?.callId).toBe("a");
    expect(queue.next("session")?.callId).toBe("b");

    expect(queue.resolveCall("session", "a", { content: [{ type: "text", text: "A" }], isError: false })).toBe(true);
    expect(queue.resolveCall("session", "b", { content: [{ type: "text", text: "B" }], isError: false })).toBe(true);
    await expect(first).resolves.toMatchObject({ content: [{ text: "A" }] });
    await expect(second).resolves.toMatchObject({ content: [{ text: "B" }] });
  });
});
