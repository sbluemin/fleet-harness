import { describe, expect, it } from "vitest";
import { ComputerUseService } from "../../features/computer-use/host/computer-use.js";
import { renderAction, renderError, renderState, windowLine } from "../../features/computer-use/host/computer-use-render.js";
import { computerUseTools, computerUseToolsFor } from "../../features/computer-use/host/computer-use-tools.js";
import { FleetHelperError, type HelperWindow } from "../../features/computer-use/runtime/fleet-helper.js";

const window: HelperWindow = { pid: 5, windowId: 10, processStartedAt: 100, startedAtSource: "launch", app: "Notepad", bundleId: "notepad.exe", bundlePath: "C:\Windows\notepad.exe", title: "Untitled", frame: { x: 0, y: 0, w: 100, h: 100 }, front: false, hidden: false, minimized: false, onCurrentSpace: false, engine: "winui" };
const text = (result: { content: readonly { text?: unknown }[] }) => String(result.content[0]?.text);
const service = (os?: "win32" | "darwin") => new ComputerUseService({ enabled: () => true, ...(os ? { os } : {}), platform: {} as never });

describe("Computer Use on Windows", () => {
  it("keeps the macOS tool list byte for byte and gives Windows the same names and schema shape", () => {
    expect(computerUseToolsFor("darwin")).toBe(computerUseTools);
    const windows = computerUseToolsFor("win32");
    expect(windows.map(({ name }) => name)).toEqual(computerUseTools.map(({ name }) => name));
    // foreground is the macOS helper's fallback path; Windows drops it from computer_action and keeps every other property.
    expect(windows.map(({ inputSchema }) => Object.keys(inputSchema.properties))).toEqual(computerUseTools.map(({ name, inputSchema }) => Object.keys(inputSchema.properties).filter((key) => name !== "computer_action" || key !== "foreground")));
    expect(Object.keys(computerUseTools[3]!.inputSchema.properties)).toContain("foreground");
    const joined = windows.map(({ description }) => description).join("\n") + JSON.stringify(windows[3]!.inputSchema);
    for (const macOnly of [".app", "Space", "bundle ID", "AppKit", "Parallels", "cmd+a"]) expect(joined).not.toContain(macOnly);
    expect(joined).toContain("ctrl+a");
    expect(service("win32").specs().map(({ description }) => description)).toEqual(windows.map(({ description }) => description));
    expect(service().specs().map(({ description }) => description)).toEqual(computerUseTools.map(({ description }) => description));
  });

  it("words window flags, errors and notes for virtual desktops and focus borrowing", () => {
    expect(windowLine("w1", window, "win32")).toContain("other-desktop");
    expect(windowLine("w1", window)).toContain("other-space");
    expect(text(renderError(new FleetHelperError("invalid_key"), undefined, undefined, "win32"))).toContain("cmd is treated as ctrl");
    expect(text(renderError(new FleetHelperError("window_unavailable", false, { reason: "other_space" }), undefined, undefined, "win32"))).toContain("virtual desktop");
    expect(text(renderError(new FleetHelperError("invalid_key")))).not.toContain("treated as ctrl");
    const reply = { sent: true, via: "uia" as const, observation: "none" as const, changes: [], notes: ["foreground_borrowed:42ms not_restored", "foreground_borrowed:7ms restored"] };
    const rendered = text(renderAction({ window: "w1", action: "click", target: "e1", reason: "t" } as never, reply, [], undefined, "win32").result);
    expect(rendered).toContain("via uia");
    expect(rendered).toContain("borrowed (42ms)");
    expect(rendered).toContain("NOT restored");
    expect(rendered).toContain("borrowed (7ms)");
  });

  it("renders the occluded Chromium image note only with an image", () => {
    const snapshot = { pid: 5, windowId: 10, processStartedAt: 100, title: "Edge", frame: window.frame };
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1", false, "win32", "occluded_chromium_may_be_stale"))).toContain("may be stale");
    expect(text(renderState("w1", snapshot, [], 0, undefined, undefined, false, "win32", "occluded_chromium_may_be_stale"))).not.toContain("may be stale");
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1"))).not.toContain("may be stale");
  });
});
