// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "./i18n/index.js";

const readStatus = vi.hoisted(() => vi.fn());
const beginLogin = vi.hoisted(() => vi.fn());
const openPanel = vi.hoisted(() => vi.fn());
const login = vi.hoisted(() => ({ phase: "idle" as string, listeners: new Set<() => void>() }));

vi.mock("./commodore-state.js", () => ({ readCommodoreCliStatus: readStatus, retryCommodore: vi.fn() }));
vi.mock("./commodore-chat.js", () => ({ commodoreCliFailure: () => null }));
vi.mock("../../settings/client/settings-door.js", () => ({ openSettingsSurface: vi.fn() }));
vi.mock("../../quota/client/summary-store.js", () => ({ getQuotaApi: () => ({ fetch: vi.fn() }) }));
vi.mock("../../quota/client/toolbar-summary.js", () => ({ requestQuotaPanelOpen: openPanel }));
vi.mock("../../quota/client/provider-login.js", () => ({
  beginClaudeLogin: beginLogin,
  getLoginStates: () => ({ claude: { phase: login.phase } }),
  subscribeLogins: (listener: () => void) => { login.listeners.add(listener); return () => { login.listeners.delete(listener); }; },
}));

const { CommodoreCliGate, useCommodoreCliStatus } = await import("./commodore-cli-status.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 테스트가 등록한 리스너만 이 테스트의 스토어다 — 다른 테스트와 섞이지 않게 매번 비운다.
function setLoginPhase(phase: string): void {
  login.phase = phase;
  for (const listener of [...login.listeners]) listener();
}

function mount(node: ReactNode): Root {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return root;
}

describe("commodore CLI status gate", () => {
  let root: Root | null = null;
  beforeEach(() => { readStatus.mockReset(); beginLogin.mockReset(); openPanel.mockReset(); login.phase = "idle"; login.listeners.clear(); });
  afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } document.body.replaceChildren(); });

  it("reads the CLI status after the Claude login card signs in", async () => {
    readStatus.mockResolvedValueOnce("signedout").mockResolvedValueOnce("ready");
    let seen: string | null = null;
    const Probe = () => { seen = useCommodoreCliStatus("t1", true).status; return null; };
    root = mount(createElement(Probe));
    await act(async () => { await Promise.resolve(); });
    expect(seen).toBe("signedout");
    readStatus.mockClear();
    await act(async () => { setLoginPhase("signed_in"); await Promise.resolve(); });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(seen).toBe("ready");
  });

  it("starts the shared Claude login and opens the Quota panel from the status line", async () => {
    const t = getT("en");
    root = mount(createElement(CommodoreCliGate, { t, status: "signedout", checking: false, recheck: () => undefined }));
    const signIn = [...document.querySelectorAll("button")].find((button) => button.textContent === "Sign in");
    expect(signIn).toBeTruthy();
    act(() => signIn!.click());
    expect(beginLogin).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledTimes(1);
  });
});
