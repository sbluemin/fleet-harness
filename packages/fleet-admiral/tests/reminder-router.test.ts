import { describe, expect, it } from "vitest";

import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import {
  createCarrierResultReminderRouter,
  formatCarrierResultReminderMessage,
  sanitizeCarrierResultReminder,
  type PtyWriteSink,
} from "../src/index.js";

describe("carrier result reminder router", () => {
  it("extracts only finalized events with system reminders", () => {
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    const unsubscribe = createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      resolveSink() {
        return createArraySink(writes);
      },
    });

    expect(handlers).toHaveLength(1);
    handlers[0]?.(trackStatusEvent());
    handlers[0]?.(finalizedEvent("done"));

    expect(writes).toEqual(["done\r"]);
    unsubscribe();
    expect(handlers).toEqual([]);
  });

  it("applies host-resolved message policy when formatting reminder chunks", () => {
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        return createArraySink(writes);
      },
      resolvePolicy() {
        return { bracketedPaste: true, lineTerminator: "\r" };
      },
    });

    handlers[0]?.(finalizedEvent("done"));

    expect(writes).toEqual(["\x1b[200~done\x1b[201~", "\r"]);
  });

  it("ignores finalized events without a string systemReminder", () => {
    let resolveCount = 0;
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        resolveCount += 1;
        return createArraySink([]);
      },
    });

    handlers[0]?.(finalizedEvent(undefined));

    expect(resolveCount).toBe(0);
  });

  it("quietly drops blank reminders after sanitization", () => {
    let resolveCount = 0;
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        resolveCount += 1;
        return createArraySink(writes);
      },
    });

    handlers[0]?.(finalizedEvent(" \t\n\r\x07\x1b[201~ "));

    expect(resolveCount).toBe(0);
    expect(writes).toEqual([]);
  });

  it("removes terminal control chars while preserving input whitespace", () => {
    expect(sanitizeCarrierResultReminder("a\x00b\tc\nd\re\x7Ff\x9Fg")).toBe("ab\tc\nd\refg");
  });

  it("removes bracketed paste end markers", () => {
    expect(sanitizeCarrierResultReminder(`a\x1b[201~b\x9B201~c`)).toBe("abc");
  });

  it("returns formatter chunks in write order", () => {
    expect(formatCarrierResultReminderMessage({ bracketedPaste: true, lineTerminator: "\n" }, "hello")).toEqual([
      "\x1b[200~hello\x1b[201~",
      "\n",
    ]);
    expect(formatCarrierResultReminderMessage({ multilineStrategy: "paste-mode" }, "a\nb")).toEqual([
      "\x1b[200~a\nb\x1b[201~",
      "\r",
    ]);
    expect(formatCarrierResultReminderMessage({ lineTerminator: "\n" }, "hello")).toEqual(["hello\n"]);
  });

  it("quietly drops when no sink resolves", () => {
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        return undefined;
      },
    });

    expect(() => handlers[0]?.(finalizedEvent("done"))).not.toThrow();
  });
});

function createArraySink(writes: string[]): PtyWriteSink {
  return {
    write(data) {
      writes.push(data);
    },
  };
}

function finalizedEvent(systemReminder: string | undefined): CarrierJobStreamEvent {
  return {
    type: "job:finalized",
    jobId: "job-1",
    status: "done",
    finishedAt: 1,
    summary: "summary",
    ...(systemReminder === undefined ? {} : { systemReminder }),
  };
}

function trackStatusEvent(): CarrierJobStreamEvent {
  return {
    type: "track:status",
    jobId: "job-1",
    trackId: "track-1",
    status: "stream",
  };
}
