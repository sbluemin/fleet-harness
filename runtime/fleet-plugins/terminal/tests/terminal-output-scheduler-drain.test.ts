import { describe, expect, it, vi } from "vitest";

import type { Terminal as XtermTerminal } from "@xterm/xterm";

import { createTerminalOutputScheduler } from "../client/shared/terminal-surface.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class WebglAddon {} }));

const INACTIVE_FLUSH_MS = 250;

describe("terminal output scheduler drain", () => {
  it("runs the callback synchronously when nothing is pending", () => {
    const { scheduler } = createHarness();
    const drained = vi.fn();
    scheduler.drain(drained);
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("waits for output written before drain to be parsed", () => {
    const { scheduler, fake } = createHarness();
    scheduler.write(new Uint8Array([1]));
    const drained = vi.fn();
    scheduler.drain(drained);
    expect(fake.writes).toHaveLength(1);
    expect(drained).not.toHaveBeenCalled();
    fake.completeWrite(0);
    expect(drained).toHaveBeenCalledTimes(1);
  });

  // 정지(quiescence) 대기 회귀 가드: drain 이후 도착한 출력이 파싱 미완이어도, drain 시점 이전
  // 바이트만 파싱되면 콜백이 풀려야 한다 — 연속 출력 중 입력 구독이 기아되면 Ctrl+C가 막힌다.
  it("does not starve behind output that arrives after drain", () => {
    const { scheduler, fake } = createHarness();
    scheduler.write(new Uint8Array([1]));
    const drained = vi.fn();
    scheduler.drain(drained);
    scheduler.write(new Uint8Array([2, 2]));
    scheduler.setActive(true);
    scheduler.setActive(false);
    fake.completeWrite(0);
    expect(drained).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("drops queued drain callbacks on dispose", () => {
    const { scheduler, fake } = createHarness();
    scheduler.write(new Uint8Array([1]));
    const drained = vi.fn();
    scheduler.drain(drained);
    scheduler.dispose();
    fake.completeWrite(0);
    expect(drained).not.toHaveBeenCalled();
  });
});

interface FakeXterm {
  readonly writes: Array<{ readonly data: Uint8Array; readonly callback?: () => void }>;
  completeWrite(index: number): void;
}

function createHarness(): { readonly scheduler: ReturnType<typeof createTerminalOutputScheduler>; readonly fake: FakeXterm } {
  const writes: Array<{ readonly data: Uint8Array; readonly callback?: () => void }> = [];
  const fake: FakeXterm = {
    writes,
    completeWrite(index) {
      writes[index]?.callback?.();
    },
  };
  const terminal = {
    write: (data: Uint8Array, callback?: () => void) => {
      writes.push({ data, ...(callback ? { callback } : {}) });
    },
  } as unknown as XtermTerminal;
  const scheduler = createTerminalOutputScheduler(terminal, false, INACTIVE_FLUSH_MS, () => {});
  return { scheduler, fake };
}
