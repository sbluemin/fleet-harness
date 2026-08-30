// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { createTerminalAlternateScreenEdgeFill } from "../client/shared/terminal-surface.js";

const dimensions = {
  css: {
    canvas: { width: 90, height: 47 },
    cell: { width: 12, height: 16 },
  },
  device: {
    canvas: { width: 192, height: 96 },
    cell: { width: 24, height: 32 },
    char: { width: 20, height: 28, left: 2, top: 2 },
  },
};

describe("terminal alternate-screen edge fill", () => {
  it("extends terminal cell backgrounds into right and bottom grid remainders", () => {
    const screen = document.createElement("div");
    const container = document.createElement("div");
    container.append(screen);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 104, 53));
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 96, 48));
    let dimensionsListener: ((value: typeof dimensions) => void) | undefined;
    const right = canvasAndContext();
    const bottom = canvasAndContext();
    const cells = [
      fakeCell({ rgb: 0x112233 }),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell({ rgb: 0x445566 }),
      fakeCell({ palette: 1 }),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell(),
      fakeCell({ rgb: 0x778899 }),
    ];
    let pendingFrame: FrameRequestCallback | undefined;
    const controller = createTerminalAlternateScreenEdgeFill({
      terminal: {
        cols: 8,
        rows: 3,
        options: { theme: { background: "#000", red: "#f00" } },
        buffer: {
          active: {
            viewportY: 0,
            getLine: (row: number) => ({ getCell: (column: number) => cells[row * 8 + column] }),
          },
        },
        onDimensionsChange: (listener: (value: typeof dimensions) => void) => {
          dimensionsListener = listener;
          return { dispose: vi.fn() };
        },
      } as never,
      container,
      screen,
      createCanvas: (edge) => edge === "right" ? right.canvas : bottom.canvas,
      requestFrame: (callback) => {
        pendingFrame = callback;
        return 1;
      },
      cancelFrame: vi.fn(),
      devicePixelRatio: () => 2,
    });

    dimensionsListener?.(dimensions);
    controller.setActive(true);
    pendingFrame?.(0);

    expect(Array.from(container.children)).toEqual(expect.arrayContaining([screen, right.canvas, bottom.canvas]));
    expect(screen.querySelector("canvas")).toBeNull();
    expect(right.canvas.hidden).toBe(false);
    expect(right.canvas.style.left).toBe("96px");
    expect(right.canvas.style.width).toBe("8px");
    expect(right.canvas.style.height).toBe("53px");
    expect(right.canvas.width).toBe(16);
    expect(right.canvas.height).toBe(106);
    expect(bottom.canvas.hidden).toBe(false);
    expect(bottom.canvas.style.top).toBe("48px");
    expect(bottom.canvas.style.width).toBe("96px");
    expect(bottom.canvas.style.height).toBe("5px");
    expect(bottom.canvas.width).toBe(192);
    expect(bottom.canvas.height).toBe(10);
    expect(right.context.fillRect).toHaveBeenCalledTimes(4);
    expect(bottom.context.fillRect).toHaveBeenCalledTimes(8);
    expect(right.context.fills).toEqual(["#000", "#f00", "rgb(119, 136, 153)", "rgb(119, 136, 153)"]);
    expect(bottom.context.fills.at(-1)).toBe("rgb(119, 136, 153)");

    controller.setActive(false);
    expect(right.canvas.hidden).toBe(true);
    expect(bottom.canvas.hidden).toBe(true);
    expect(right.canvas.width).toBe(0);
    expect(bottom.canvas.height).toBe(0);
    controller.dispose();
  });

  it("repaints with the last geometry when resize schedules overlap", () => {
    const screen = document.createElement("div");
    const container = document.createElement("div");
    container.append(screen);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 104, 53));
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 96, 48));
    let dimensionsListener: ((value: typeof dimensions) => void) | undefined;
    const right = canvasAndContext();
    const bottom = canvasAndContext();
    const frames: FrameRequestCallback[] = [];
    const controller = createTerminalAlternateScreenEdgeFill({
      terminal: {
        cols: 8,
        rows: 3,
        options: { theme: { background: "#000" } },
        buffer: { active: { viewportY: 0, getLine: () => undefined } },
        onDimensionsChange: (listener: (value: typeof dimensions) => void) => {
          dimensionsListener = listener;
          return { dispose: vi.fn() };
        },
      } as never,
      container,
      screen,
      createCanvas: (edge) => edge === "right" ? right.canvas : bottom.canvas,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    dimensionsListener?.(dimensions);
    controller.setActive(true);
    controller.schedulePaint();
    expect(frames).toHaveLength(1);

    vi.mocked(screen.getBoundingClientRect).mockReturnValue(domRect(0, 0, 100, 50));
    frames.shift()?.(0);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);

    expect(right.canvas.style.left).toBe("100px");
    expect(right.canvas.style.width).toBe("4px");
    expect(bottom.canvas.style.top).toBe("50px");
    expect(bottom.canvas.style.height).toBe("3px");
    controller.dispose();
  });

  it("does not add a paint layer when the grid consumes the entire surface", () => {
    const screen = document.createElement("div");
    const container = document.createElement("div");
    container.append(screen);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 96, 48));
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 96, 48));
    let dimensionsListener: ((value: typeof dimensions) => void) | undefined;
    const right = canvasAndContext();
    const bottom = canvasAndContext();
    let pendingFrame: FrameRequestCallback | undefined;
    const controller = createTerminalAlternateScreenEdgeFill({
      terminal: {
        cols: 8,
        rows: 3,
        options: { theme: { background: "#000" } },
        buffer: { active: { viewportY: 0, getLine: () => undefined } },
        onDimensionsChange: (listener: (value: typeof dimensions) => void) => {
          dimensionsListener = listener;
          return { dispose: vi.fn() };
        },
      } as never,
      container,
      screen,
      createCanvas: (edge) => edge === "right" ? right.canvas : bottom.canvas,
      requestFrame: (callback) => {
        pendingFrame = callback;
        return 1;
      },
    });

    dimensionsListener?.(dimensions);
    controller.setActive(true);
    pendingFrame?.(0);

    expect(right.canvas.hidden).toBe(true);
    expect(bottom.canvas.hidden).toBe(true);
    controller.dispose();
  });
});

function canvasAndContext() {
  const canvas = document.createElement("canvas");
  const fills: string[] = [];
  let fillStyle = "";
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(() => fills.push(fillStyle)),
    fills,
    get fillStyle() { return fillStyle; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = String(value); },
  };
  vi.spyOn(canvas, "getContext").mockReturnValue(context as never);
  return { canvas, context };
}

function fakeCell(options: { readonly rgb?: number; readonly palette?: number; readonly inverse?: boolean } = {}) {
  const color = options.rgb ?? options.palette ?? 0;
  return {
    getBgColor: () => color,
    getFgColor: () => color,
    isBgRGB: () => options.rgb !== undefined,
    isFgRGB: () => options.rgb !== undefined,
    isBgPalette: () => options.palette !== undefined,
    isFgPalette: () => options.palette !== undefined,
    isInverse: () => options.inverse ? 1 : 0,
  };
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}
