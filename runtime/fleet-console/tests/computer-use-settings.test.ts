// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MobileSettingsHostContext } from "../features/settings/client/mobile-host.js";
import { ComputerUseRow } from "../features/settings/client/computer-use-row.js";
import type { ComputerUseSettingsStatus } from "../features/computer-use/shared/status.js";

const ready: ComputerUseSettingsStatus = { enabled: true, supported: true, helperAvailable: true, missingPermissions: [], permissionHolder: null, selfCheckFailed: false };
const mounted: (() => void)[] = [];
afterEach(() => { for (const cleanup of mounted.splice(0)) cleanup(); vi.unstubAllGlobals(); });

async function mount(status: ComputerUseSettingsStatus, mobile = false, stored = true) {
  const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("permission-request") ? { requested: ["accessibility"] } : status)));
  vi.stubGlobal("fetch", fetch);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounted.push(() => { act(() => root.unmount()); node.remove(); });
  const row = createElement(ComputerUseRow, { enabled: stored, saving: false, onChange: vi.fn(), mobile });
  await act(async () => { root.render(mobile ? createElement(MobileSettingsHostContext.Provider, { value: { moreLabel: "More", openChoice: () => {} } }, row) : row); });
  return { node, fetch, toggle: node.querySelector<HTMLInputElement>('input[aria-label="Computer Use"]')! };
}

it("locks a missing helper but preserves its saved opt-in; other platforms are effectively off", async () => {
  const absent = await mount({ ...ready, helperAvailable: false, missingPermissions: null });
  expect(absent.node.textContent).toContain("Available only when Console runs in the Fleet Console desktop app.");
  expect(absent.toggle.disabled).toBe(true);
  expect(absent.toggle.checked).toBe(true);
  const unsupported = await mount({ ...ready, enabled: false, helperAvailable: false, supported: false, missingPermissions: null }, true);
  expect(unsupported.node.querySelector('[role="status"]')?.textContent).toContain("Available on macOS only for now.");
  expect(unsupported.toggle.disabled).toBe(true);
  expect(unsupported.toggle.checked).toBe(false);
});

it("names only the missing permission and keeps the toggle usable while requesting permissions", async () => {
  const view = await mount({ ...ready, enabled: false, missingPermissions: ["accessibility"] }, false, false);
  const notice = view.node.querySelector('[role="status"]')!;
  expect(notice.textContent).toContain("Fleet Console needs Accessibility permission.");
  expect(notice.textContent).not.toContain("Screen Recording");
  expect(view.toggle.disabled).toBe(false);
  const button = Array.from(notice.querySelectorAll("button")).find((item) => item.textContent === "Request permissions")!;
  await act(async () => { button.click(); });
  expect(view.fetch.mock.calls.at(-1)).toMatchObject(["/api/v1/computer-use/permission-request", { method: "POST" }]);
});

it("names the app macOS judges, such as Fleet Console Dev in a dev run, and adds the Screen Recording steps only when it is missing", async () => {
  const view = await mount({ ...ready, missingPermissions: ["accessibility", "screenRecording"], permissionHolder: "Fleet Console Dev" });
  const notice = view.node.querySelector('[role="status"]')?.textContent;
  expect(notice).toContain("Fleet Console Dev needs Accessibility and Screen Recording permission. If it isn't in the Screen & System Audio Recording list, add it with +; if it already looks on, turn it off and on again. If the app doesn't reopen after Quit & Reopen, open it again yourself. macOS may ask you to confirm once more on the next screen capture.");
  const accessibilityOnly = await mount({ ...ready, missingPermissions: ["accessibility"], permissionHolder: "Fleet Console Dev" });
  const short = accessibilityOnly.node.querySelector('[role="status"]')?.textContent;
  expect(short).toContain("Fleet Console Dev needs Accessibility permission.");
  for (const line of ["System Audio Recording list", "Quit & Reopen", "next screen capture"]) expect(short).not.toContain(line);
});

it("keeps the toggle on when startup self-check pauses control and has no notice in normal use", async () => {
  const paused = await mount({ ...ready, selfCheckFailed: true });
  expect(paused.node.textContent).toContain("Self-check failed on this macOS version, so app control is paused.");
  expect(paused.toggle.checked).toBe(true);
  expect(paused.toggle.disabled).toBe(false);
  const normal = await mount(ready);
  expect(normal.node.querySelector('[role="status"]')).toBeNull();
});
