import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Terminal as XtermTerminal } from "@xterm/xterm";

import { createTerminalOutputScheduler } from "../client/shared/terminal-surface.js";
import { DEFAULT_TERMINAL_INACTIVE_FLUSH, terminalInactiveFlushMs, isTerminalInactiveFlush } from "../client/shared/terminal-preferences.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class WebglAddon {} }));

const ACTIVE_FLUSH_MS = 16;

function createScheduler(initiallyActive: boolean, inactiveFlushMs: number) {
  const writes: Uint8Array[] = [];
  const terminal = {
    write: (data: Uint8Array, callback?: () => void) => {
      writes.push(data);
      callback?.();
    },
  } as unknown as XtermTerminal;
  return { writes, scheduler: createTerminalOutputScheduler(terminal, initiallyActive, inactiveFlushMs, () => {}) };
}

describe("inactive flush presets", () => {
  it("keeps the pre-setting behavior as the default", () => {
    expect(DEFAULT_TERMINAL_INACTIVE_FLUSH).toBe("balanced");
    expect(terminalInactiveFlushMs("balanced")).toBe(250);
  });

  it("orders the presets from least to most frequent, and never below the active rate", () => {
    expect(terminalInactiveFlushMs("saving")).toBeGreaterThan(terminalInactiveFlushMs("balanced"));
    expect(terminalInactiveFlushMs("balanced")).toBeGreaterThan(terminalInactiveFlushMs("instant"));
    // 가장 빠른 단도 활성 주기보다는 느리다 — 비활성 패널이 활성 패널만큼 비싸지는 선택지는 없다.
    expect(terminalInactiveFlushMs("instant")).toBeGreaterThan(ACTIVE_FLUSH_MS);
  });

  it("rejects unknown stored values", () => {
    expect(isTerminalInactiveFlush("balanced")).toBe(true);
    expect(isTerminalInactiveFlush("off")).toBe(false);
    expect(isTerminalInactiveFlush(null)).toBe(false);
    expect(isTerminalInactiveFlush(250)).toBe(false);
  });
});

describe("terminal output scheduler inactive flush interval", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("holds inactive output for the configured interval", () => {
    const { writes, scheduler } = createScheduler(false, 500);
    scheduler.write(new Uint8Array([1]));

    vi.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);

    scheduler.dispose();
  });

  it("leaves the active interval untouched by the setting", () => {
    const { writes, scheduler } = createScheduler(true, 500);
    scheduler.write(new Uint8Array([1]));

    vi.advanceTimersByTime(ACTIVE_FLUSH_MS);
    expect(writes).toHaveLength(1);

    scheduler.dispose();
  });

  it("reschedules a pending flush onto the new interval", () => {
    const { writes, scheduler } = createScheduler(false, 500);
    scheduler.write(new Uint8Array([1]));
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(0);

    scheduler.setInactiveFlushMs(50);
    vi.advanceTimersByTime(49);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);

    scheduler.dispose();
  });

  it("applies a changed interval to output that arrives later", () => {
    const { writes, scheduler } = createScheduler(false, 50);
    scheduler.setInactiveFlushMs(500);

    scheduler.write(new Uint8Array([1]));
    vi.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);

    scheduler.dispose();
  });

  it("does not disturb an active terminal's pending flush", () => {
    const { writes, scheduler } = createScheduler(true, 250);
    scheduler.write(new Uint8Array([1]));
    vi.advanceTimersByTime(10);

    scheduler.setInactiveFlushMs(500);
    vi.advanceTimersByTime(6);
    expect(writes).toHaveLength(1);

    scheduler.dispose();
  });
});
