// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MobileSettingsHostContext } from "../features/settings/client/mobile-host.js";
import { ComputerUseRow } from "../features/settings/client/computer-use-row.js";
import type { ComputerUseSettingsStatus } from "../features/computer-use/shared/status.js";

const ready: ComputerUseSettingsStatus = { enabled: true, supported: true, helperAvailable: true, missingPermissions: [], selfCheckFailed: false };
const mounted: (() => void)[] = [];
afterEach(() => { for (const cleanup of mounted.splice(0)) cleanup(); vi.unstubAllGlobals(); });

async function mount(status: ComputerUseSettingsStatus, mobile = false, stored = true) {
  const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("privacy-settings") ? { opened: true } : status)));
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

it("names only the missing permission and keeps the toggle usable while opening Privacy Settings", async () => {
  const view = await mount({ ...ready, enabled: false, missingPermissions: ["accessibility"] }, false, false);
  const notice = view.node.querySelector('[role="status"]')!;
  expect(notice.textContent).toContain("Fleet Console needs Accessibility permission.");
  expect(notice.textContent).not.toContain("Screen Recording");
  expect(view.toggle.disabled).toBe(false);
  const button = Array.from(notice.querySelectorAll("button")).find((item) => item.textContent === "Open Privacy Settings")!;
  await act(async () => { button.click(); });
  expect(view.fetch.mock.calls.at(-1)).toMatchObject(["/api/v1/computer-use/privacy-settings", { method: "POST" }]);
});

it("keeps the toggle on when startup self-check pauses control and has no notice in normal use", async () => {
  const paused = await mount({ ...ready, selfCheckFailed: true });
  expect(paused.node.textContent).toContain("Self-check failed on this macOS version, so app control is paused.");
  expect(paused.toggle.checked).toBe(true);
  expect(paused.toggle.disabled).toBe(false);
  const normal = await mount(ready);
  expect(normal.node.querySelector('[role="status"]')).toBeNull();
});
