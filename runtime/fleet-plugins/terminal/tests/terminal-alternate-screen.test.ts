import { describe, expect, it, vi } from "vitest";

import { createTerminalAlternateScreenController } from "../client/shared/terminal-alternate-screen.js";

interface FakeBuffer {
  readonly type: "normal" | "alternate";
}

class FakeTerminal {
  readonly cols = 80;
  readonly rows = 24;
  readonly options: { scrollbar: { showScrollbar: boolean } } = { scrollbar: { showScrollbar: true } };
  readonly writes: string[] = [];
  private activeBuffer: FakeBuffer = { type: "normal" };
  private bufferListener: ((buffer: FakeBuffer) => void) | null = null;
  private readonly csiHandlers = new Map<string, (params: Array<number | number[]>) => boolean>();
  private readonly escHandlers = new Map<string, () => boolean>();

  readonly buffer = {
    get active() { return thisTerminal.activeBuffer; },
    onBufferChange: (listener: (buffer: FakeBuffer) => void) => {
      this.bufferListener = listener;
      return { dispose: () => { this.bufferListener = null; } };
    },
  };

  readonly parser = {
    registerCsiHandler: (id: { readonly prefix?: string; readonly final: string }, handler: (params: Array<number | number[]>) => boolean) => {
      const key = `${id.prefix ?? ""}${id.final}`;
      this.csiHandlers.set(key, handler);
      return { dispose: () => { this.csiHandlers.delete(key); } };
    },
    registerEscHandler: (id: { readonly final: string }, handler: () => boolean) => {
      this.escHandlers.set(id.final, handler);
      return { dispose: () => { this.escHandlers.delete(id.final); } };
    },
  };

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    if (data.includes("?1049h")) this.activate("alternate");
    if (data.includes("?1047l")) this.activate("normal");
    callback?.();
  }

  activate(type: FakeBuffer["type"]): void {
    this.activeBuffer = { type };
    this.bufferListener?.(this.activeBuffer);
  }

  emitCsi(final: "h" | "l", params: number[]): void {
    this.csiHandlers.get(`?${final}`)?.(params);
    const mode = params.find((value) => value === 47 || value === 1047 || value === 1049);
    if (mode !== undefined) this.activate(final === "h" ? "alternate" : "normal");
  }

  emitReset(): void {
    this.escHandlers.get("c")?.();
    this.activate("normal");
  }
}

let thisTerminal: FakeTerminal;

describe("terminal alternate screen controller", () => {
  it("hides the scrollbar, refits, and resizes once on live alternate entry", () => {
    const terminal = new FakeTerminal();
    thisTerminal = terminal;
    const fit = vi.fn();
    const resizePty = vi.fn();
    const onAlternateScreenChange = vi.fn();
    const controller = createTerminalAlternateScreenController({
      terminal: terminal as never,
      fitAddon: { fit },
      resizePty,
      isReplaying: () => false,
      onAlternateScreenChange,
    });

    terminal.emitCsi("h", [1049]);

    expect(terminal.options.scrollbar.showScrollbar).toBe(false);
    expect(onAlternateScreenChange).toHaveBeenLastCalledWith(true);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resizePty).toHaveBeenCalledWith(80, 24);

    terminal.emitCsi("l", [1049]);
    expect(terminal.options.scrollbar.showScrollbar).toBe(true);
    expect(onAlternateScreenChange).toHaveBeenLastCalledWith(false);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(resizePty).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("coalesces replay transitions into the final sideband state", () => {
    const terminal = new FakeTerminal();
    thisTerminal = terminal;
    const fit = vi.fn();
    const resizePty = vi.fn();
    let replaying = true;
    const controller = createTerminalAlternateScreenController({
      terminal: terminal as never,
      fitAddon: { fit },
      resizePty,
      isReplaying: () => replaying,
    });

    terminal.emitCsi("h", [1049]);
    terminal.emitCsi("l", [1049]);
    terminal.emitCsi("h", [1049]);
    expect(fit).not.toHaveBeenCalled();

    replaying = false;
    controller.finishReplay({ alternateScreenActive: true });

    expect(terminal.options.scrollbar.showScrollbar).toBe(false);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resizePty).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("restores missing alternate and mouse modes after bounded replay", () => {
    const terminal = new FakeTerminal();
    thisTerminal = terminal;
    const fit = vi.fn();
    const controller = createTerminalAlternateScreenController({
      terminal: terminal as never,
      fitAddon: { fit },
      resizePty: vi.fn(),
      isReplaying: () => false,
    });

    const state = {
      alternateScreenActive: true,
      mouseProtocol: "vt200" as const,
      mouseEncoding: "sgr" as const,
    };
    controller.prepareReplay(state);
    controller.finishReplay(state);

    expect(terminal.writes).toEqual([
      "\x1b[?1049h\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l\x1b[?1000h\x1b[?1006h",
      "\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l\x1b[?1000h\x1b[?1006h",
    ]);
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(terminal.options.scrollbar.showScrollbar).toBe(false);
    expect(fit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("returns to normal scrollbar policy on RIS", () => {
    const terminal = new FakeTerminal();
    thisTerminal = terminal;
    const controller = createTerminalAlternateScreenController({
      terminal: terminal as never,
      fitAddon: { fit: vi.fn() },
      resizePty: vi.fn(),
      isReplaying: () => false,
    });
    terminal.emitCsi("h", [1049]);

    terminal.emitReset();

    expect(terminal.options.scrollbar.showScrollbar).toBe(true);
    controller.dispose();
  });
});
