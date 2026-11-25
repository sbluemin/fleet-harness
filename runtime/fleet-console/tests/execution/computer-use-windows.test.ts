import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComputerUseService } from "../../features/computer-use/host/computer-use.js";
import { renderAction, renderError, renderState, windowLine } from "../../features/computer-use/host/computer-use-render.js";
import { computerUseTools, computerUseToolsFor } from "../../features/computer-use/host/computer-use-tools.js";
import { parseDeviceInput } from "../../features/computer-use/host/computer-use-input.js";
import { FleetHelperError, type HelperWindow } from "../../features/computer-use/runtime/fleet-helper.js";

const window: HelperWindow = { pid: 5, windowId: 10, processStartedAt: 100, startedAtSource: "launch", app: "Notepad", bundleId: "notepad.exe", bundlePath: "C:\Windows\notepad.exe", title: "Untitled", frame: { x: 0, y: 0, w: 100, h: 100 }, front: false, hidden: false, minimized: false, onCurrentSpace: false, engine: "winui" };
const text = (result: { content: readonly { text?: unknown }[] }) => String(result.content[0]?.text);
// macOS 도구 목록 기준: canary 39cf65fad의 computerUseTools를 JSON.stringify한 고정본(git show로 추출).
const DARWIN_BASELINE = readFileSync(new URL("../fixtures/computer-use-tools-darwin-39cf65fad.json", import.meta.url), "utf8");
const service = (os?: "win32" | "darwin") => new ComputerUseService({ enabled: () => true, ...(os ? { os } : {}), platform: {} as never });

describe("Computer Use on Windows", () => {
  it("keeps the macOS tool list byte for byte and gives Windows the same names and schema shape", () => {
    expect(computerUseToolsFor("darwin")).toBe(computerUseTools);
    expect(JSON.stringify(computerUseToolsFor("darwin"))).toBe(DARWIN_BASELINE);
    expect(JSON.stringify(service("darwin").specs().map(({ id, description, parameters }) => ({ name: id, description, inputSchema: parameters })))).toBe(DARWIN_BASELINE);
    expect(JSON.stringify(service().specs().map(({ id, description, parameters }) => ({ name: id, description, inputSchema: parameters })))).toBe(DARWIN_BASELINE);
    const windows = computerUseToolsFor("win32");
    expect(windows.map(({ name }) => name)).toEqual(computerUseTools.map(({ name }) => name));
    // foreground is the macOS helper's fallback path; Windows drops it from computer_action, adds the menu path, and keeps every other property.
    expect(windows.map(({ inputSchema }) => Object.keys(inputSchema.properties))).toEqual(computerUseTools.map(({ name, inputSchema }) => {
      const keys = Object.keys(inputSchema.properties).filter((key) => name !== "computer_action" || key !== "foreground");
      return name === "computer_action" ? [...keys, "menu"] : keys;
    }));
    expect(Object.keys(computerUseTools[3]!.inputSchema.properties)).not.toContain("menu");
    expect(Object.keys(computerUseTools[3]!.inputSchema.properties)).toContain("foreground");
    // 모든 Windows 설명과 스키마(필드 설명 포함)에서 mac 전용 어휘를 금지한다.
    const everything = JSON.stringify(windows);
    for (const macOnly of [".app", "Space", "bundle ID", "AppKit", "WebKit", "Parallels", "VM screen", "cmd+a", "⌫", "AI cursor", "foreground:true", "other-space"]) expect(everything).not.toContain(macOnly);
    expect(everything).toContain("ctrl+a");
    expect(windows[0]!.inputSchema.properties.query.description).toBe("Filter by app name, ID, path or window title; also list matching installed apps for computer_open.");
    expect(windows[3]!.inputSchema.properties.key.description).toBe("Named key or shortcut (Return, ctrl+a), not text. cmd means ctrl; the Windows key is unsupported.");
    expect(service("win32").specs().map(({ description }) => description)).toEqual(windows.map(({ description }) => description));
    expect(service().specs().map(({ description }) => description)).toEqual(computerUseTools.map(({ description }) => description));
  });

  it("words window flags, errors and notes for virtual desktops and focus borrowing", () => {
    expect(windowLine("w1", window, "win32")).toContain("other-desktop");
    expect(windowLine("w1", window)).toContain("other-space");
    expect(text(renderError(new FleetHelperError("invalid_key"), undefined, undefined, "win32"))).toContain("cmd is treated as ctrl");
    expect(text(renderError(new FleetHelperError("window_unavailable", false, { reason: "other_space" }), undefined, undefined, "win32"))).toContain("On another virtual desktop: screenshot only (computer_state with image:true). For control, ask the user to move the window to this desktop.");
    expect(text(renderError(new FleetHelperError("invalid_key")))).not.toContain("treated as ctrl");
    expect(text(renderError(new FleetHelperError("invalid_key"), undefined, undefined, "win32"))).toContain("Windows key unsupported.");
    const click = { window: "w1", action: "click", target: "e1", reason: "t" } as never;
    const reply = { sent: true, via: "uia" as const, observation: "none" as const, changes: [], notes: ["foreground_borrowed:42ms not_restored", "foreground_borrowed:7ms restored"] };
    const rendered = text(renderAction(click, reply, [], undefined, "win32").result);
    expect(rendered).toContain("via uia");
    expect(rendered).toContain("note: Focus borrowed (42ms); previous window NOT restored — tell the user.");
    expect(rendered).toContain("note: Focus borrowed (7ms); previous window restored.");
    // via uia alone never implies borrowing.
    expect(text(renderAction(click, { ...reply, notes: [] }, [], undefined, "win32").result)).not.toContain("Focus borrowed");
    const setValue = { window: "w1", action: "set_value", target: "e1", text: "x", reason: "t" } as never;
    expect(text(renderAction(setValue, { ...reply, notes: [] }, [], undefined, "win32").result)).toContain("note: App change events may not fire.");
    expect(text(renderAction(setValue, { ...reply, notes: [] }, [], undefined, "darwin").result)).toContain("note: Setting an AX value may not fire app change events.");
  });

  it("renders the occluded Chromium image note only with an image", () => {
    const snapshot = { pid: 5, windowId: 10, processStartedAt: 100, title: "Edge", frame: window.frame };
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1", false, "win32", "occluded_chromium_may_be_stale"))).toContain("note: Fully covered window; screenshot may be stale. Use available elements, or ask the user to uncover it if current pixels are needed.");
    const viewOnly = text(renderState("w1", snapshot, [], 0, undefined, "v1", true, "win32", "occluded_chromium_may_be_stale"));
    expect(viewOnly).toContain("view-only: another virtual desktop; no elements or input, even by coordinates. For control, ask the user to move the window here.");
    expect(viewOnly).toContain("note: Fully covered window; screenshot may be stale. If current pixels are needed, ask the user to uncover the window.");
    expect(viewOnly).not.toContain("Use available elements");
    expect(text(renderState("w1", snapshot, [], 0, undefined, undefined, false, "win32", "occluded_chromium_may_be_stale"))).not.toContain("may be stale");
    expect(text(renderState("w1", snapshot, [], 0, undefined, "v1"))).not.toContain("may be stale");
  });

  it("accepts a menu path only on Windows and renders its notes and missing-item hint", () => {
    const menuClick = { window: "w1", action: "click", target: "e2", menu: ["보기", "확대"], reason: "zoom in" };
    expect(parseDeviceInput("computer_action", menuClick, "win32")).toMatchObject({ menu: ["보기", "확대"] });
    expect(() => parseDeviceInput("computer_action", menuClick)).toThrow();
    expect(() => parseDeviceInput("computer_action", { window: "w1", action: "click", x: 1, y: 2, view: "v1", menu: ["a"], reason: "r" }, "win32")).toThrow();
    expect(() => parseDeviceInput("computer_action", { window: "w1", action: "key", key: "escape", menu: ["a"], reason: "r" }, "win32")).toThrow();
    const closed = { sent: true, via: "uia" as const, observation: "none" as const, changes: [], notes: ["foreground_borrowed:40ms restored", "menu_closed_on_restore"] };
    expect(text(renderAction({ window: "w1", action: "click", target: "e2", reason: "open" }, closed, [], undefined, "win32").result)).toContain("note: Menu closed when focus returned. To choose an item, use menu with the menu-bar item's ID as target.");
    // The final item was not invoked (an earlier menu may have opened); the observed borrow, incl. NOT restored, stays on the result.
    const missing = new FleetHelperError("menu_item_not_found", false, { step: 2, available: ["새 탭", "열기"], availableCount: 2, notes: ["foreground_borrowed:120ms not_restored"] });
    const missingText = text(renderError(missing, menuClick as never, undefined, "win32"));
    expect(missingText.split("\n")[0]).toBe('click e2: final item not invoked: menu_item_not_found — Step 2: no exact match. Visible items: "새 탭", "열기".');
    expect(missingText).toContain("note: Focus borrowed (120ms); previous window NOT restored — tell the user.");
    const many = new FleetHelperError("menu_item_not_found", false, { step: 1, available: Array.from({ length: 25 }, (_, i) => `item ${i}`), availableCount: 30 });
    expect(text(renderError(many, undefined, undefined, "win32"))).toContain('"item 19" … (+10 more).');
    expect(text(renderError(new FleetHelperError("menu_item_not_found", false, { step: 3, available: [] }), undefined, undefined, "win32"))).toContain("Step 3: no items observed.");
    expect(text(renderError(new FleetHelperError("background_unavailable"), menuClick as never, undefined, "win32"))).toContain("click e2: not sent: background_unavailable");
  });
});
