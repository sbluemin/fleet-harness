import { describe, it, beforeEach, expect } from "vitest";
import {
  registerStreamHandler,
  unregisterStreamHandler,
  emitStreamEvent,
  clearStreamHandlers,
  type AgentStreamHandler,
} from "../../src/admiral/agent/events.js";
import type { AgentStreamEvent } from "../../src/admiral/agent/types.js";

describe("admiral.agent.events", () => {
  beforeEach(() => {
    clearStreamHandlers();
  });

  it("register는 unsubscribe 함수를 반환하고, 호출 시 핸들러가 제거된다", () => {
    const events: AgentStreamEvent[] = [];
    const handler: AgentStreamHandler = (e) => events.push(e);
    const unsubscribe = registerStreamHandler(handler);

    emitStreamEvent({ type: "text", sessionId: "s1", text: "hello" });
    expect(events).toHaveLength(1);

    unsubscribe();

    emitStreamEvent({ type: "text", sessionId: "s1", text: "world" });
    expect(events).toHaveLength(1);
  });

  it("unregister로 핸들러를 직접 제거할 수 있다", () => {
    const events: AgentStreamEvent[] = [];
    const handler: AgentStreamHandler = (e) => events.push(e);

    registerStreamHandler(handler);
    emitStreamEvent({ type: "text", sessionId: "s1", text: "a" });
    expect(events).toHaveLength(1);

    unregisterStreamHandler(handler);
    emitStreamEvent({ type: "text", sessionId: "s1", text: "b" });
    expect(events).toHaveLength(1);
  });

  it("clear는 모든 핸들러를 제거한다", () => {
    const events1: AgentStreamEvent[] = [];
    const events2: AgentStreamEvent[] = [];
    registerStreamHandler((e) => events1.push(e));
    registerStreamHandler((e) => events2.push(e));

    emitStreamEvent({ type: "text", sessionId: "s1", text: "a" });
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    clearStreamHandlers();

    emitStreamEvent({ type: "text", sessionId: "s1", text: "b" });
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it("이벤트는 등록 순서대로 전달된다", () => {
    const order: string[] = [];
    registerStreamHandler(() => order.push("first"));
    registerStreamHandler(() => order.push("second"));
    registerStreamHandler(() => order.push("third"));

    emitStreamEvent({ type: "text", sessionId: "s1", text: "x" });
    expect(order).toEqual(["first", "second", "third"]);
  });
});
