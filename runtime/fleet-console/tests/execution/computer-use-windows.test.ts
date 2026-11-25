import { describe, expect, it } from "vitest";
import { ComputerUseService } from "../../features/computer-use/host/computer-use.js";
import { renderAction, renderError, renderState, windowLine } from "../../features/computer-use/host/computer-use-render.js";
import { computerUseTools, computerUseToolsFor } from "../../features/computer-use/host/computer-use-tools.js";
import { parseDeviceInput } from "../../features/computer-use/host/computer-use-input.js";
import { FleetHelperError, type HelperWindow } from "../../features/computer-use/runtime/fleet-helper.js";

const window: HelperWindow = { pid: 5, windowId: 10, processStartedAt: 100, startedAtSource: "launch", app: "Notepad", bundleId: "notepad.exe", bundlePath: "C:\Windows\notepad.exe", title: "Untitled", frame: { x: 0, y: 0, w: 100, h: 100 }, front: false, hidden: false, minimized: false, onCurrentSpace: false, engine: "winui" };
const text = (result: { content: readonly { text?: unknown }[] }) => String(result.content[0]?.text);
const service = (os?: "win32" | "darwin") => new ComputerUseService({ enabled: () => true, ...(os ? { os } : {}), platform: {} as never });

describe("Computer Use on Windows", () => {
  it("keeps the macOS tool list and gives Windows the same names with its own schema differences", () => {
    expect(computerUseToolsFor("darwin")).toBe(computerUseTools);
    const windows = computerUseToolsFor("win32");
    expect(windows.map(({ name }) => name)).toEqual(computerUseTools.map(({ name }) => name));
    // foreground is the macOS helper's fallback path; Windows drops it from computer_action and adds the menu path.
    expect(windows.map(({ inputSchema }) => Object.keys(inputSchema.properties))).toEqual(computerUseTools.map(({ name, inputSchema }) => {
      const keys = Object.keys(inputSchema.properties).filter((key) => name !== "computer_action" || key !== "foreground");
      return name === "computer_action" ? [...keys, "menu"] : keys;
    }));
    expect(Object.keys(computerUseTools[3]!.inputSchema.properties)).toContain("foreground");
    expect(Object.keys(computerUseTools[3]!.inputSchema.properties)).not.toContain("menu");
    // No macOS-only guidance anywhere in the Windows list, field descriptions included.
    const everything = JSON.stringify(windows);
    for (const macOnly of [".app", "Space", "bundle ID", "AppKit", "Parallels", "cmd+a"]) expect(everything).not.toContain(macOnly);
    expect(service("win32").specs().map(({ description }) => description)).toEqual(windows.map(({ description }) => description));
    expect(service().specs().map(({ description }) => description)).toEqual(computerUseTools.map(({ description }) => description));
  });

  it("words window flags, errors and notes for virtual desktops and focus borrowing", () => {
    expect(windowLine("w1", window, "win32")).toContain("other-desktop");
    expect(windowLine("w1", window)).toContain("other-space");
    expect(text(renderError(new FleetHelperError("invalid_key"), undefined, undefined, "win32"))).toContain("cmd is treated as ctrl");
    expect(text(renderError(new FleetHelperError("window_unavailable", false, { reason: "other_space" }), undefined, undefined, "win32"))).toContain("virtual desktop");
    expect(text(renderError(new FleetHelperError("invalid_key")))).not.toContain("treated as ctrl");
    const click = { window: "w1", action: "click", target: "e1", reason: "t" } as never;
    const reply = { sent: true, via: "uia" as const, observation: "none" as const, changes: [], notes: ["foreground_borrowed:42ms not_restored", "foreground_borrowed:7ms restored"] };
    const rendered = text(renderAction(click, reply, [], undefined, "win32").result);
    expect(rendered).toContain("via uia");
    expect(rendered).toContain("borrowed (42ms)");
    expect(rendered).toContain("NOT restored");
    expect(rendered).toContain("borrowed (7ms)");
    // Borrowing is reported only when the helper observed it, never inferred from via uia.
    expect(text(renderAction(click, { ...reply, notes: [] }, [], undefined, "win32").result)).not.toContain("borrowed");
  });

  it("renders the occluded Chromium image note only with an image", () => {
    const snapshot = { pid: 5, windowId: 10, processStartedAt: 100, title: "Edge", frame: window.frame };
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1", false, "win32", "occluded_chromium_may_be_stale"))).toContain("may be stale");
    expect(text(renderState("w1", snapshot, [], 0, undefined, undefined, false, "win32", "occluded_chromium_may_be_stale"))).not.toContain("may be stale");
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1"))).not.toContain("may be stale");
  });

  it("accepts a menu path only on Windows and reports a missing item as not invoked, keeping the restore outcome", () => {
    const menuClick = { window: "w1", action: "click", target: "e2", menu: ["확대/축소", "확대"], reason: "zoom in" };
    expect(parseDeviceInput("computer_action", menuClick, "win32")).toMatchObject({ menu: ["확대/축소", "확대"] });
    expect(() => parseDeviceInput("computer_action", menuClick)).toThrow();
    expect(() => parseDeviceInput("computer_action", { window: "w1", action: "click", x: 1, y: 2, view: "v1", menu: ["a"], reason: "r" }, "win32")).toThrow();
    expect(() => parseDeviceInput("computer_action", { window: "w1", action: "key", key: "escape", menu: ["a"], reason: "r" }, "win32")).toThrow();
    const closed = { sent: true, via: "uia" as const, observation: "none" as const, changes: [], notes: ["menu_closed_on_restore"] };
    expect(text(renderAction({ window: "w1", action: "click", target: "e2", reason: "open" }, closed, [], undefined, "win32").result)).toContain("Menu closed");
    // An earlier menu may have opened, so the outcome is "final item not invoked", and a failed restore still reaches the agent.
    const missing = new FleetHelperError("menu_item_not_found", false, { step: 2, available: ["새 탭"], availableCount: 1, notes: ["foreground_borrowed:120ms not_restored"] });
    const missingText = text(renderError(missing, menuClick as never, undefined, "win32"));
    expect(missingText.startsWith("click e2: final item not invoked: menu_item_not_found")).toBe(true);
    expect(missingText).toContain("NOT restored");
    expect(text(renderError(new FleetHelperError("background_unavailable"), menuClick as never, undefined, "win32"))).toContain("not sent");
  });
});
