import { describe, expect, it, vi } from "vitest";

import { createLaunchController } from "../src/launch-controller.js";

describe("launch controller", () => {
  it("shows entry before startOrAdopt and arms the exact loopback origin before handoff", async () => {
    const order: string[] = [];
    const contents = { executeJavaScript: vi.fn(async () => undefined) };
    const window = { webContents: contents, show: vi.fn(() => order.push("show")), loadURL: vi.fn(async () => { order.push("handoff"); }) };
    const controller = createLaunchController({ createWindow: vi.fn(async () => window), pushEntry: vi.fn(async () => { order.push("entry"); }), startOrAdopt: vi.fn(async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; }), handoffOrigin: vi.fn((origin) => { order.push(`origin=${origin}`); }) });
    await controller.start();
    expect(order).toEqual(["entry", "show", "start", "origin=http://127.0.0.1:4310", "entry", "handoff"]);
  });
});
