// @vitest-environment jsdom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "./i18n/index.js";

const readStatus = vi.hoisted(() => vi.fn());
const beginLogin = vi.hoisted(() => vi.fn());
const openPanel = vi.hoisted(() => vi.fn());
const login = vi.hoisted(() => ({ phase: "idle" as string, listeners: new Set<() => void>() }));

vi.mock("./commodore-state.js", () => ({ readCommodoreCliStatus: readStatus, retryCommodore: vi.fn() }));
vi.mock("./commodore-chat.js", () => ({
  commodoreCliFailure: (entries: readonly { readonly code?: string }[]) => {
    const code = entries.at(-1)?.code;
    return code === "agent_cli_unavailable" ? "missing" : code === "agent_signed_out" ? "signedout" : null;
  },
}));
vi.mock("../../settings/client/settings-door.js", () => ({ openSettingsSurface: vi.fn() }));
vi.mock("../../quota/client/summary-store.js", () => ({ getQuotaApi: () => ({ fetch: vi.fn() }) }));
vi.mock("../../quota/client/toolbar-summary.js", () => ({ requestQuotaPanelOpen: openPanel }));
vi.mock("../../quota/client/provider-login.js", () => ({
  beginClaudeLogin: beginLogin,
  getLoginStates: () => ({ claude: { phase: login.phase } }),
  subscribeLogins: (listener: () => void) => { login.listeners.add(listener); return () => { login.listeners.delete(listener); }; },
}));

const { CliFailureCard, CommodoreCliGate, useCliStatusProbe, useCommodoreCliStatus } = await import("./commodore-cli-status.js");

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

  it("re-reads the CLI status when a CLI failure newly appears, for both causes", async () => {
    readStatus.mockResolvedValue("ready");
    let setFailure!: (value: "missing" | "signedout" | null) => void;
    let seen: string | null = null;
    const Probe = () => {
      const [failure, update] = useState<"missing" | "signedout" | null>(null);
      setFailure = update;
      seen = useCommodoreCliStatus("t1", true, failure).status;
      return null;
    };
    root = mount(createElement(Probe));
    await act(async () => { await Promise.resolve(); });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(seen).toBe("ready");
    // ready에서 보낸 턴이 CLI 없음으로 실패하면 다시 읽어 C1 상태 줄이 선다.
    readStatus.mockResolvedValueOnce("missing");
    await act(async () => { setFailure("missing"); await Promise.resolve(); });
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(seen).toBe("missing");
    // 성공한 턴이 카드를 내리고, 그 뒤 미로그인으로 실패해도 같은 경로를 다시 읽는다.
    readStatus.mockResolvedValueOnce("signedout");
    await act(async () => { setFailure(null); await Promise.resolve(); });
    expect(readStatus).toHaveBeenCalledTimes(2);
    await act(async () => { setFailure("signedout"); await Promise.resolve(); });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(seen).toBe("signedout");
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

  it("renders the shared CliFailureCard for missing and signedout causes without a CLI path picker", () => {
    const t = getT("ko");
    const onResend = vi.fn();
    root = mount(createElement(CliFailureCard, { t, cause: "missing", onResend }));
    const missingButtons = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(missingButtons).toEqual(["설치 방법", "다시 보내기"]);
    expect(document.body.textContent).not.toContain("CLI 경로 지정");
    act(() => { document.querySelectorAll("button")[1]!.click(); });
    expect(onResend).toHaveBeenCalledTimes(1);

    act(() => root!.unmount());
    root = mount(createElement(CliFailureCard, { t, cause: "signedout", onResend }));
    const signedOutButtons = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(signedOutButtons).toEqual(["로그인", "다시 보내기"]);
    act(() => { document.querySelectorAll("button")[0]!.click(); });
    expect(beginLogin).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it("supports custom status readers via useCliStatusProbe for commander chat", async () => {
    const reader = vi.fn().mockResolvedValueOnce("missing").mockResolvedValueOnce("ready");
    let seen: string | null = null;
    let recheck!: () => void;
    const Probe = () => {
      const state = useCliStatusProbe("obj-1", true, null, reader);
      seen = state.status;
      recheck = state.recheck;
      return null;
    };
    root = mount(createElement(Probe));
    await act(async () => { await Promise.resolve(); });
    expect(seen).toBe("missing");
    await act(async () => { recheck(); await Promise.resolve(); });
    expect(seen).toBe("ready");
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
