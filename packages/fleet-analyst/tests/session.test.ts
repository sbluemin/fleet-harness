import { EventEmitter } from "node:events";

import type { IUnifiedAgentClient } from "@dotobokuri/core-unified-agent";
import { afterEach, expect, it, vi } from "vitest";

import { AnalystSession } from "../src/session.js";

afterEach(() => { vi.useRealTimers(); });

it("rejects sends before start and disposes idempotently", async () => {
  const session = new AnalystSession({
    capturePath: "/not-used-before-start.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });

  await expect(session.send("hello")).rejects.toThrow("Session not started");
  await expect(session.dispose()).resolves.toBeUndefined();
  await expect(session.dispose()).resolves.toBeUndefined();
});

it("bridges provider exits as analysis_exited errors", () => {
  const events: unknown[] = [];
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
    onEvent: event => events.push(event),
  });
  const client = new EventEmitter() as unknown as IUnifiedAgentClient;

  (session as unknown as { bridge(value: IUnifiedAgentClient): void }).bridge(client);
  (client as unknown as EventEmitter).emit("exit", 7, "SIGTERM");

  expect(events).toEqual([{
    type: "error",
    error: { code: "analysis_exited", message: "Analysis process exited (code 7, signal SIGTERM)" },
  }]);
});

it("cancels an active turn, bounds disposal, and rejects sends once disposal begins", async () => {
  vi.useFakeTimers();
  const never = new Promise<never>(() => undefined);
  const client = {
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(() => never),
  } as unknown as IUnifiedAgentClient;
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });
  const state = session as unknown as { client: IUnifiedAgentClient; started: boolean };
  state.client = client;
  state.started = true;
  void session.send("long prompt");
  await Promise.resolve();

  const disposal = session.dispose();
  expect(client.cancelPrompt).toHaveBeenCalledOnce();
  await expect(session.send("too late")).rejects.toThrow("Session disposed");
  expect(client.disconnect).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2_000);
  await disposal;
  expect(client.disconnect).toHaveBeenCalledOnce();
});
