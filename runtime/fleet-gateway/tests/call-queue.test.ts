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

  it("caps pending calls per session", async () => {
    const queue = createGatewayCallQueue({ maxPendingCalls: 1, timeoutMs: 10_000 });
    const first = queue.enqueue("session", "a", "tool", {});
    const capped = queue.enqueue("session", "b", "tool", {});

    await expect(capped).resolves.toMatchObject({ isError: true, content: [{ text: "Too many pending tool calls" }] });
    expect(queue.resolveCall("session", "a", { content: [{ type: "text", text: "A" }], isError: false })).toBe(true);
    await expect(first).resolves.toMatchObject({ content: [{ text: "A" }] });
  });

  it("can release delivered calls for at-least-once redelivery", () => {
    const queue = createGatewayCallQueue({ timeoutMs: 10_000 });
    void queue.enqueue("session", "a", "tool", {});

    expect(queue.next("session")?.callId).toBe("a");
    expect(queue.next("session")).toBeNull();
    expect(queue.releaseDelivered("session", "a")).toBe(true);
    expect(queue.next("session")?.callId).toBe("a");

    queue.clear();
  });
});
