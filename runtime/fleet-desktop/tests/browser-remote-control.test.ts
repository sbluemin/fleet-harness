import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DESKTOP_BROWSER_ANSWER_PERMISSION, DESKTOP_BROWSER_CLEANUP_FILES, DESKTOP_BROWSER_STAGE_FILES, type DesktopBrowserChrome, type DesktopBrowserViewerSnapshot } from "@fleet-console/protocol/desktop";
import { createBrowserActions } from "../src/browser-actions.js";
import { createBrowserRemoteShell, remotePasswordPrompt } from "../src/browser-remote-shell.js";
import { chromeControlFor, type SurfaceControl } from "../src/browser-surface.js";
import { createRemoteBrowserViewer } from "../src/browser-viewer.js";
import { chromeViewLocked, readChromeMessage } from "../src/chrome/contract.js";
import type { PasswordPrompt } from "../src/browser-password-page.js";

const ORIGIN = "http://127.0.0.1:44777";

function chrome(over: Partial<DesktopBrowserChrome> = {}): DesktopBrowserChrome {
  return {
    browserId: "global",
    spaces: [{ id: "default", kind: "default", label: "", driving: true, agentTabIds: ["tab-1"], viewportPreset: "responsive", control: "agent", pointer: { tabId: "tab-1", x: 12, y: 8, kind: "move", seq: 3, actor: "Ada" } }],
    tabs: [{ id: "tab-1", spaceId: "default", url: "https://example.com/path", title: "Example", favicon: null, loading: false, canGoBack: true, canGoForward: false }],
    activeTabId: "tab-1",
    viewport: { preset: "responsive", width: 1280, height: 800, setBy: null },
    driving: true,
    profile: null,
    defaultProfile: null,
    available: true,
    reason: null,
    ...over,
  };
}

function snapshot(remoteControl: boolean | undefined, status: DesktopBrowserViewerSnapshot["executionHost"]["status"] = "connected"): DesktopBrowserViewerSnapshot {
  return {
    chrome: chrome(),
    executionHost: { managed: false, connected: status === "connected", status, hostLabel: "work", platform: "darwin", accessPath: "loopback" },
    ...(remoteControl === undefined ? {} : { remoteControl }),
    passwordPrompt: { kind: "save-prompt", id: "password-tab-1", tabId: "tab-1", origin: "https://example.com", username: "ada", mode: "save" },
  };
}

function control(): SurfaceControl & { notices: string[] } {
  const notices: string[] = [];
  const ui = { pinned: false, expanded: false, orientation: "vertical" as const, autoExpand: true, overlay: null, busy: false, notice: null, info: null, suggest: null, suggestions: [], draft: null, guardPill: null };
  return {
    notices,
    ui: () => ui,
    patch(change) { Object.assign(ui, change); },
    notify(text) { notices.push(text ?? ""); },
    chrome: () => chrome(),
    surface: () => ({ id: "viewer-1", browserId: "global", mode: "pane" }),
    space: () => "default",
    chooseSpace: () => ({ kind: "select", tabId: "tab-1" }),
    evaluate() { /* 주석 답은 이 테스트에서 쓰지 않는다 */ },
    focus() { /* 초점 이동 없음 */ },
    control: () => null,
  };
}

async function openViewer(body: DesktopBrowserViewerSnapshot, posts: { url: string; init: RequestInit | undefined }[]) {
  const applied: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    posts.push({ url: href, init });
    if (href.includes("/viewer/stream")) {
      return new Response("not found", { status: 404 });
    }
    if (href.includes("/viewer/chrome") && !href.includes("/events") && !href.includes("/frame")) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (href.includes("/frame") || href.includes("/events")) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response("{}", { status: 200 });
  });
  const viewer = createRemoteBrowserViewer({
    display: {
      apply(...args) { applied.push(args); },
      conceal() { /* 닫힘 */ },
      viewing: () => true,
      frame() { /* 프레임은 이 테스트 밖 */ },
    },
    fetch: fetchImpl as typeof fetch,
    lang: "en",
    localAct() { /* 표시줄 모양만 */ },
    openExternal: vi.fn(),
  });
  viewer.follow(ORIGIN);
  viewer.toggle();
  await vi.waitFor(() => {
    const view = (applied.at(-1) as unknown[] | undefined)?.[3] as { place?: string } | undefined;
    if (!view?.place) throw new Error("waiting");
  });
  return { viewer, applied, fetchImpl };
}

describe("remote browser shell", () => {
  it("relays chrome actions to the remote console without a managed lock when remoteControl is connected", async () => {
    const posts: { url: string; init: RequestInit | undefined }[] = [];
    const { viewer, applied } = await openViewer(snapshot(true), posts);
    const viewOnly = (applied.at(-1) as unknown[])[3] as { control?: boolean; passwordPrompt?: { password?: string } };
    expect(viewOnly.control).toBe(true);
    expect(viewOnly.passwordPrompt && "password" in viewOnly.passwordPrompt).toBe(false);
    const handle = control();
    viewer.act(handle, "bar", { action: "navigate", url: "https://example.com/next" });
    viewer.act(handle, "bar", { action: "password-save", promptId: "password-tab-1", tabId: "tab-1" });
    await vi.waitFor(() => { if (!posts.some((call) => call.url.includes("/password-action"))) throw new Error("waiting"); });
    const navigate = posts.find((call) => call.url.includes("/navigate"));
    const password = posts.find((call) => call.url.includes("/password-action"));
    expect(navigate?.url.startsWith(`${ORIGIN}/api/v1/browser/objectives/global/navigate`)).toBe(true);
    expect(JSON.parse(String(navigate?.init?.body))).toEqual({ url: "https://example.com/next", spaceId: "default" });
    const headers = new Headers(navigate?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("origin")).toBe(ORIGIN);
    expect(JSON.parse(String(password?.init?.body))).toEqual({ promptId: "password-tab-1", tabId: "tab-1", action: "save" });
    expect(String(password?.init?.body)).not.toContain("s3cr3t");
    viewer.stop();
  });

  it("drops writes for unmanaged and legacy snapshots", async () => {
    for (const body of [snapshot(undefined, "unmanaged"), snapshot(false, "manager_disconnected")]) {
      const posts: { url: string; init: RequestInit | undefined }[] = [];
      const { viewer, applied } = await openViewer(body, posts);
      const viewOnly = (applied.at(-1) as unknown[])[3] as { control?: boolean };
      expect(viewOnly.control).toBeUndefined();
      viewer.act(control(), "bar", { action: "navigate", url: "https://example.com/nope" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(posts.some((call) => call.url.includes("/navigate"))).toBe(false);
      viewer.stop();
    }
  });

  it("omits managed headers on a cookie session and keeps the guard for remote control", async () => {
    const seen: Headers[] = [];
    const actions = createBrowserActions({
      fetch: (async (_url, init) => { seen.push(new Headers(init?.headers)); return new Response("{}"); }) as typeof fetch,
      origin: () => ORIGIN,
      headers: () => ({ Authorization: "Bearer secret" }),
      cookieSession: true,
      lang: "en",
      openExternal() { /* 이 기계의 브라우저 */ },
      log() { /* 없음 */ },
    });
    actions(control(), "bar", { action: "new-tab" });
    await vi.waitFor(() => { if (seen.length === 0) throw new Error("waiting"); });
    expect(seen[0]?.get("authorization")).toBeNull();
    expect(chromeViewLocked({ place: "work", status: "connected" })).toBe(true);
    expect(chromeViewLocked({ place: "work", status: "connected", control: true })).toBe(false);
    const held = chromeControlFor(chrome(), "default", { place: "work", status: "connected", control: true }, 1);
    expect(held).toEqual({ holder: "agent", spaceId: "default", reason: null, pointer: { x: 12, y: 8, kind: "move", seq: 3, actor: "Ada" } });
    expect(chromeControlFor(chrome(), "default", { place: "work", status: "connected" }, 1)).toBeNull();
    expect(readChromeMessage(JSON.stringify(["fleet-chrome", "bar", "permission-answer", { promptId: "perm-1", tabId: "tab-1", allow: true }])))
      .toEqual({ role: "bar", action: { action: "permission-answer", promptId: "perm-1", tabId: "tab-1", allow: true } });
  });

  it("publishes a masked password prompt and answers a permission without plaintext", async () => {
    const shell = createBrowserRemoteShell();
    const flushed: ReturnType<typeof shell.relayExtras>[] = [];
    shell.setFlush(() => { flushed.push(shell.relayExtras()); });
    shell.bindView(7, "tab-1");
    const prompt: PasswordPrompt = { kind: "save-prompt", viewId: "tab-1", origin: "https://example.com", username: "ada", password: "s3cr3t", mode: "save" };
    shell.notePassword(prompt);
    expect(remotePasswordPrompt(prompt)).toEqual({ kind: "save-prompt", id: "password-tab-1", tabId: "tab-1", origin: "https://example.com", username: "ada", mode: "save" });
    expect(JSON.stringify(shell.relayExtras())).not.toContain("s3cr3t");
    let allowed: boolean | null = null;
    shell.requestPermission({ webContentsId: 7, permission: "geolocation", origin: "https://example.com", callback: (value) => { allowed = value; } });
    const pending = shell.relayExtras().permissionPrompts[0];
    expect(pending?.permission).toBe("geolocation");
    await shell.command(DESKTOP_BROWSER_ANSWER_PERMISSION, { promptId: pending!.id, tabId: "tab-1", allow: true }, { async chromeAction() { /* 권한은 금고로 가지 않는다 */ } });
    expect(allowed).toBe(true);
    expect(shell.relayExtras().permissionPrompts).toEqual([]);
    expect(flushed.length).toBeGreaterThan(0);

    const staged = await shell.command(DESKTOP_BROWSER_STAGE_FILES, {
      viewId: "tab-1",
      files: [{ name: "../../evil.txt", contentBase64: Buffer.from("hello-upload").toString("base64") }],
    }, { async chromeAction() {} });
    expect(staged.handled).toBe(true);
    const { stagingId, paths } = staged.result as { stagingId: string; paths: string[] };
    expect(paths).toHaveLength(1);
    expect(fs.readFileSync(paths[0]!, "utf8")).toBe("hello-upload");
    await shell.command(DESKTOP_BROWSER_CLEANUP_FILES, { stagingId }, { async chromeAction() {} });
    expect(fs.existsSync(paths[0]!)).toBe(false);

    // 탭이 닫히거나(unbindView) 안전 TTL 이 지나도 임시 파일이 정리된다.
    const onTab = await shell.command(DESKTOP_BROWSER_STAGE_FILES, {
      viewId: "tab-1",
      files: [{ name: "later.txt", contentBase64: Buffer.from("later").toString("base64") }],
    }, { async chromeAction() {} });
    const tabPaths = (onTab.result as { paths: string[] }).paths;
    expect(fs.existsSync(tabPaths[0]!)).toBe(true);
    shell.unbindView(7);
    expect(fs.existsSync(tabPaths[0]!)).toBe(false);

    const ttlShell = createBrowserRemoteShell({ stagingTtlMs: 15 });
    const ttlStaged = await ttlShell.command(DESKTOP_BROWSER_STAGE_FILES, {
      viewId: "tab-ttl",
      files: [{ name: "ttl.txt", contentBase64: Buffer.from("ttl").toString("base64") }],
    }, { async chromeAction() {} });
    const ttlPaths = (ttlStaged.result as { paths: string[] }).paths;
    expect(fs.existsSync(ttlPaths[0]!)).toBe(true);
    await vi.waitFor(() => { expect(fs.existsSync(ttlPaths[0]!)).toBe(false); });
    ttlShell.cleanupAll();
  });
});
