import { describe, expect, it, vi } from "vitest";

import { parseAccessLink } from "../src/remote-access-link.js";
import { createRuntimePairing, parsePairingTarget, verifyPairingTarget } from "../src/runtime-pairing.js";

const TOKEN = "y8bWk3Qm5r7uJ2pS4vX9zA1cE6gI0lN8oR2tU5wY7bD";
const FINGERPRINT = "6FB70D9F321A91894CC16D613078FB13E6E0B0042D985D395F04EDC2103E95F8";
const ACCESS_LINK = `https://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`;
const REMOTE_ORIGIN = "https://192.168.1.20:4310";

describe("runtime pairing", () => {
  it("accepts only a canonical literal loopback address and validates the frozen identity without redirects", async () => {
    expect(parsePairingTarget("127.0.0.1:4310")).toEqual({ kind: "loopback", origin: "http://127.0.0.1:4310" });
    for (const input of ["localhost:4310", "127.0.0.1:04310", "127.0.0.1:0", "127.0.0.1:65536", "http://127.0.0.1:4310"]) {
      expect(() => parsePairingTarget(input)).toThrow("pairing_target_invalid");
    }
    const fetchFor = vi.fn(async () => identityResponse());
    await expect(verifyPairingTarget("127.0.0.1:4310", fetchFor)).resolves.toEqual({ origin: "http://127.0.0.1:4310", consoleUrl: "http://127.0.0.1:4310/console/" });
    expect(fetchFor).toHaveBeenCalledWith("http://127.0.0.1:4310/api/v1/pairing-identity", expect.objectContaining({ method: "GET", redirect: "error" }));
    await expect(verifyPairingTarget("127.0.0.1:4310", async () => responseAtIdentity("{}", { "content-length": "9000" }))).rejects.toThrow("pairing_target_response_too_large");
  });

  it("reads an access link as its own target kind and refuses a plaintext or credential-bearing one", () => {
    expect(parsePairingTarget(ACCESS_LINK)).toEqual({ kind: "link", link: parseAccessLink(ACCESS_LINK) });
    for (const input of [
      `http://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`,
      `https://user:pass@192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`,
      `https://192.168.1.20:4310/console/#t=${TOKEN}&f=${FINGERPRINT}`,
      `https://192.168.1.20:4310/join#t=${TOKEN}`,
      "https://192.168.1.20:4310/join",
    ]) {
      expect(() => parsePairingTarget(input)).toThrow("pairing_target_invalid");
    }
  });

  it("stages, commits, and notifies only after the target Console loads", async () => {
    const order: string[] = [];
    const policy = { ...policyStub(), stageConsoleOrigin: vi.fn(() => order.push("stage")), commitConsoleOrigin: vi.fn(() => order.push("commit")), cancelPendingConsoleOrigin: vi.fn(() => order.push("cancel")) };
    const notifier = { show: vi.fn(() => order.push("notification")) };
    const theme = { stop: vi.fn(() => order.push("theme-stop")), start: vi.fn(async () => { order.push("theme-start"); }) };
    const window = runtimeWindow(async () => { order.push("load"); });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: theme as never, modal: modalReturning(null), fetch: async () => identityResponse() });
    await pairing.switchTo("127.0.0.1:4310", window as never, policy);
    expect(order).toEqual(["stage", "load", "commit", "theme-stop", "theme-start", "notification"]);
    expect(window.webContents.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("rolls back the pending origin and restores the previous page before reporting failure", async () => {
    const policy = policyStub();
    const notifier = { show: vi.fn() };
    const loadURL = vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValueOnce(undefined);
    const window = runtimeWindow(loadURL);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), fetch: async () => identityResponse() });
    await pairing.switchTo("127.0.0.1:4310", window as never, policy);
    expect(policy.commitConsoleOrigin).not.toHaveBeenCalled();
    expect(policy.cancelPendingConsoleOrigin).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4000/console/");
    expect(notifier.show).toHaveBeenCalledOnce();
  });

  it("rolls back the prior policy and theme synchronizer when a post-commit step fails", async () => {
    const policy = policyStub();
    const theme = { stop: vi.fn(), start: vi.fn().mockRejectedValueOnce(new Error("target theme failed")).mockResolvedValueOnce(undefined) };
    const notifier = { show: vi.fn() };
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: theme as never, modal: modalReturning(null), fetch: async () => identityResponse() });

    await pairing.switchTo("127.0.0.1:4310", runtimeWindow(loadURL) as never, policy);

    expect(policy.activateConsoleOrigin).toHaveBeenCalledWith("http://127.0.0.1:4000");
    expect(loadURL).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4000/console/");
    expect(theme.start).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4310");
    expect(theme.start).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4000");
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("activates fullscreen publishing only after pairing commits, resets the prior origin, and republishes it on rollback", async () => {
    const policy = policyStub();
    const fullscreen = { activate: vi.fn(), reset: vi.fn(), resync: vi.fn(), stop: vi.fn() };
    const pairing = createRuntimePairing({
      ...pairingDefaults(),
      notifier: { show: vi.fn() },
      fullscreenSynchronizer: () => fullscreen,
      themeSynchronizer: { stop: vi.fn(), start: vi.fn(async () => undefined) } as never,
      modal: modalReturning(null),
      fetch: async () => identityResponse(),
    });

    await pairing.switchTo("127.0.0.1:4310", runtimeWindow(vi.fn(async () => undefined)) as never, policy);
    expect(fullscreen.activate).toHaveBeenCalledWith("http://127.0.0.1:4310");
    expect(fullscreen.reset).toHaveBeenCalledWith("http://127.0.0.1:4000");

    const rollbackFullscreen = { activate: vi.fn(), reset: vi.fn(), resync: vi.fn(), stop: vi.fn() };
    const rollback = createRuntimePairing({
      ...pairingDefaults(),
      notifier: { show: vi.fn() },
      fullscreenSynchronizer: () => rollbackFullscreen,
      themeSynchronizer: { stop: vi.fn(), start: vi.fn().mockRejectedValueOnce(new Error("theme failed")).mockResolvedValueOnce(undefined) } as never,
      modal: modalReturning(null),
      fetch: async () => identityResponse(),
    });
    await rollback.switchTo("127.0.0.1:4310", runtimeWindow(vi.fn(async () => undefined)) as never, policy);
    expect(rollbackFullscreen.activate).toHaveBeenCalledWith("http://127.0.0.1:4000");
    expect(rollbackFullscreen.resync).toHaveBeenCalledOnce();
  });

  it("pins the link fingerprint before any request reaches that host and only then joins and verifies", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order);
    const policy = trackingPolicy();
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async (url) => { order.push(`load:${url}`); }) as never, policy);

    expect(order).toEqual(["confirm", "pin", "join", `fetch:${REMOTE_ORIGIN}/api/v1/pairing-identity`, `load:${REMOTE_ORIGIN}/console/`]);
    expect(remote.pin).toHaveBeenCalledWith(expect.objectContaining({ hostname: "192.168.1.20", fingerprint: FINGERPRINT }));
    expect(policy.admitRemoteConsoleOrigin).toHaveBeenCalledWith(REMOTE_ORIGIN);
    expect(policy.currentConsoleOrigin()).toBe(REMOTE_ORIGIN);
  });

  it("never admits the remote origin when the link is malformed and never touches that host", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order);
    const policy = trackingPolicy();
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(`http://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`, runtimeWindow(async () => undefined) as never, policy);

    expect(order).toEqual([]);
    expect(policy.admitRemoteConsoleOrigin).not.toHaveBeenCalled();
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("not a Fleet Console access link") }));
  });

  it("releases the pin and the admitted origin when the grant is refused, and returns to the local runtime", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order, { join: async () => { order.push("join-rejected"); throw new Error("remote_link_rejected"); } });
    const policy = trackingPolicy();
    const notifier = { show: vi.fn() };
    const window = runtimeWindow(async (url) => { order.push(`load:${url}`); });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, window as never, policy);

    expect(remote.unpin).toHaveBeenCalledWith(expect.objectContaining({ hostname: "192.168.1.20" }));
    expect(remote.forget).toHaveBeenCalledOnce();
    expect(policy.withdrawRemoteConsoleOrigin).toHaveBeenCalledWith(REMOTE_ORIGIN);
    expect(policy.currentConsoleOrigin()).toBe("http://127.0.0.1:4000");
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ body: "The access link was already used or has expired. Create a new one." }));
    const entryScripts = window.webContents.executeJavaScript.mock.calls as unknown as readonly (readonly string[])[];
    expect(entryScripts.at(-1)?.[0]).toContain('"state":"failed"');
    expect(entryScripts.some(([source]) => source?.includes("Console ready"))).toBe(false);
  });

  it("does not publish the ready handoff snapshot when the joined host is not a Fleet Console", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order, { fetch: async (input: string) => responseAtUrl("{}", input) });
    const window = runtimeWindow(async () => undefined);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, window as never, trackingPolicy());

    const entryScripts = window.webContents.executeJavaScript.mock.calls as unknown as readonly (readonly string[])[];
    expect(entryScripts.some(([source]) => source?.includes("Console ready"))).toBe(false);
    expect(remote.unpin).toHaveBeenCalledOnce();
  });

  it("returns from a committed remote link to the local runtime and forgets that remote session", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order);
    const policy = trackingPolicy();
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policy);
    await pairing.switchTo("http://127.0.0.1:4000", runtimeWindow(async () => undefined) as never, policy);

    expect(remote.forget).toHaveBeenCalledWith(expect.objectContaining({ origin: REMOTE_ORIGIN }));
    expect(policy.withdrawRemoteConsoleOrigin).toHaveBeenCalledWith(REMOTE_ORIGIN);
    expect(policy.currentConsoleOrigin()).toBe("http://127.0.0.1:4000");
  });

  it("stops a fingerprint mismatch before the browser ever sees that host", async () => {
    const order: string[] = [];
    const remote = remoteAccessStub(order, { confirmIdentity: async () => { order.push("confirm"); throw new Error("remote_link_fingerprint_mismatch"); } });
    const policy = trackingPolicy();
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async (url) => { order.push(`load:${url}`); }) as never, policy);

    // 브라우저가 그 호스트를 한 번이라도 보면 실패가 캐시되어 다음 올바른 링크까지 막힌다.
    expect(order).toEqual(["confirm", "load:http://127.0.0.1:4000/console/"]);
    expect(remote.pin).not.toHaveBeenCalled();
    expect(remote.join).not.toHaveBeenCalled();
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(policy.admitRemoteConsoleOrigin).not.toHaveBeenCalled();
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("different certificate") }));
  });

  it("keeps the live pin when a second link to the same console fails to join", async () => {
    const order: string[] = [];
    let joins = 0;
    const remote = remoteAccessStub(order, {
      join: async () => {
        joins += 1;
        order.push("join");
        if (joins > 1) throw new Error("remote_link_rejected");
      },
    });
    const policy = trackingPolicy();
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });
    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policy);

    const staleLink = `https://192.168.1.20:4310/join#t=${TOKEN.slice(0, -1)}z&f=${FINGERPRINT}`;
    await pairing.switchTo(staleLink, runtimeWindow(async () => undefined) as never, policy);

    expect(remote.unpin).not.toHaveBeenCalled();
    expect(remote.forget).not.toHaveBeenCalled();
    expect(policy.withdrawRemoteConsoleOrigin).not.toHaveBeenCalled();
    expect(remote.pin).toHaveBeenLastCalledWith(expect.objectContaining({ token: TOKEN }));
  });

  it("ignores concurrent switch requests while a remote transition is in flight", async () => {
    const order: string[] = [];
    let resolveJoin: (() => void) | undefined;
    const remote = remoteAccessStub(order, { join: () => new Promise<void>((resolve) => { resolveJoin = resolve; }) });
    const logger = { info: vi.fn(), error: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote, logger });
    const window = runtimeWindow(async () => undefined);
    const policy = trackingPolicy();

    const first = pairing.switchTo(ACCESS_LINK, window as never, policy);
    await vi.waitFor(() => expect(remote.join).toHaveBeenCalledOnce());
    await pairing.switchTo("http://127.0.0.1:4000", window as never, policy);
    resolveJoin?.();
    await first;

    expect(logger.info).toHaveBeenCalledWith("managed runtime pairing ignored code=transition_in_progress");
    expect(policy.stageConsoleOrigin).toHaveBeenCalledOnce();
  });

  it("reports that remote links are unavailable when no remote adapter is wired", async () => {
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null) });

    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, trackingPolicy());

    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "This Fleet Console Desktop cannot open remote links.", type: "error" });
  });

  it("restores the previous local Console route when the remote link fails", async () => {
    const loadURL = vi.fn(async () => undefined);
    const window = runtimeWindow(loadURL);
    window.webContents.getURL = () => "http://127.0.0.1:4000/console/operations";
    const remote = remoteAccessStub([], { join: async () => { throw new Error("remote_link_unreachable"); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, window as never, trackingPolicy());

    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4000/console/operations");
  });

  it("falls back to the local Console base route when the prior URL is not a local Console route", async () => {
    const loadURL = vi.fn(async () => undefined);
    const window = runtimeWindow(loadURL);
    window.webContents.getURL = () => "https://example.test/console/operations";
    const remote = remoteAccessStub([], { join: async () => { throw new Error("remote_link_unreachable"); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, window as never, trackingPolicy());

    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4000/console/");
  });

  it("shows remote progress, then returns to the durable local runtime and reports the failure", async () => {
    const order: string[] = [];
    const notifier = { show: vi.fn(() => order.push("failure-dialog")) };
    const policy = { ...policyStub(), stageConsoleOrigin: vi.fn(() => order.push("stage-local")), commitConsoleOrigin: vi.fn(() => order.push("commit-local")) };
    const window = runtimeWindow(async (url) => { order.push(`load:${url}`); });
    window.loadFile.mockImplementation(async () => { order.push("entry"); });
    window.webContents.executeJavaScript.mockImplementation(async () => { order.push("snapshot"); });
    const remote = remoteAccessStub([], { join: async () => { throw new Error("remote_link_unreachable"); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });

    await pairing.switchTo(ACCESS_LINK, window as never, policy);

    expect(order).toEqual(expect.arrayContaining(["entry", "snapshot", "stage-local", "load:http://127.0.0.1:4000/console/", "commit-local", "failure-dialog"]));
    expect(order.lastIndexOf("snapshot")).toBeLessThan(order.indexOf("load:http://127.0.0.1:4000/console/"));
    expect(order.indexOf("commit-local")).toBeLessThan(order.indexOf("failure-dialog"));
  });

  it("reports an unavailable local runtime instead of claiming it remains available", async () => {
    const notifier = { show: vi.fn() };
    const remote = remoteAccessStub([], { join: async () => { throw new Error("remote_link_unreachable"); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote, fetch: async () => responseAtIdentity("{}") });
    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policyStub());
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "Local Fleet Console is unavailable. Restart Fleet Console.", type: "error" });
  });

  it("logs remote release failures after a successful local return", async () => {
    const remote = remoteAccessStub([], { forget: async () => { throw new Error("cookie cleanup failed"); } });
    const logger = { info: vi.fn(), error: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote, logger });
    const policy = trackingPolicy();

    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policy);
    await pairing.switchTo("http://127.0.0.1:4000", runtimeWindow(async () => undefined) as never, policy);

    expect(logger.error).toHaveBeenCalledWith("remote access release failed code=pairing_failed");
  });

  it.each([
    ["remote_link_fingerprint_mismatch", "That console presented a different certificate than the link expects. Create the link again from that console, and do not use this one."],
    ["remote_link_rejected", "The access link was already used or has expired. Create a new one."],
    ["remote_link_host_mismatch", "The remote console refused this address. Create the link again from that console."],
    ["remote_link_unreachable", "Could not reach that console, or its certificate did not match the link."],
    ["remote_link_unverified", "The remote console refused the access link."],
    ["pairing_target_unverified", "That address is not a compatible Fleet Console runtime."],
    ["pairing_target_unavailable", "Could not reach that Fleet Console. Check that it is still running."],
  ])("shows a safe, actionable message for %s", async (code, body) => {
    const notifier = { show: vi.fn() };
    const remote = remoteAccessStub([], { join: async () => { throw Object.assign(new Error("redacted"), { code }); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });
    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policyStub());
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body, type: "error" });
  });

  it("keeps unknown failure details out of the user-facing message", async () => {
    const notifier = { show: vi.fn() };
    const remote = remoteAccessStub([], { join: async () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); } });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });
    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, policyStub());
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "The connection failed. Local Fleet Console remains available.", type: "error" });
  });

  it("serializes the Desktop modal prompt and sends its raw target through the existing verifier", async () => {
    let resolvePrompt: ((value: string | null) => void) | undefined;
    const modal = { prompt: vi.fn(() => new Promise<string | null>((resolve) => { resolvePrompt = resolve; })) };
    const loadURL = vi.fn(async () => undefined);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: async () => identityResponse() });
    const policy = policyStub();
    const window = runtimeWindow(loadURL);

    const first = pairing.prompt(window as never, policy);
    const second = pairing.prompt(window as never, policy);
    expect(modal.prompt).toHaveBeenCalledOnce();
    resolvePrompt?.("127.0.0.1:4310");
    await Promise.all([first, second]);
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
  });

  it("does not prompt a destroyed parent window", async () => {
    const modal = modalReturning("127.0.0.1:4310");
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: vi.fn() });
    const window = { ...runtimeWindow(vi.fn()), isDestroyed: () => true };
    await pairing.prompt(window as never, policyStub());
    expect(modal.prompt).not.toHaveBeenCalled();
  });

  it("unpins and forgets the committed remote link on dispose", async () => {
    const remote = remoteAccessStub([]);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), remoteAccess: remote });
    await pairing.switchTo(ACCESS_LINK, runtimeWindow(async () => undefined) as never, trackingPolicy());

    await pairing.dispose();

    expect(remote.unpin).toHaveBeenCalledWith(expect.objectContaining({ origin: REMOTE_ORIGIN }));
    expect(remote.forget).toHaveBeenCalledWith(expect.objectContaining({ origin: REMOTE_ORIGIN }));
  });
});

function runtimeWindow(loadURL: (url: string) => Promise<void>) {
  return {
    isDestroyed: () => false,
    loadFile: vi.fn(async () => undefined),
    loadURL,
    webContents: {
      getURL: () => "http://127.0.0.1:4000/console/",
      executeJavaScript: vi.fn(async () => undefined),
      navigationHistory: { clear: vi.fn() },
    },
  };
}

function pairingDefaults() {
  return { entryPagePath: "/entry.html", localOrigin: () => "http://127.0.0.1:4000", fetch: async (input: string) => identityResponseAt(input) };
}

function policyStub() {
  return {
    activateConsoleOrigin: vi.fn(),
    currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"),
    stageConsoleOrigin: vi.fn(),
    commitConsoleOrigin: vi.fn(),
    cancelPendingConsoleOrigin: vi.fn(),
    admitRemoteConsoleOrigin: vi.fn(),
    withdrawRemoteConsoleOrigin: vi.fn(),
  };
}

/** 실제 정책처럼 활성 origin이 이동하는 스텁. 원격→로컬 왕복은 이 이동이 있어야 성립한다. */
function trackingPolicy() {
  let currentOrigin = "http://127.0.0.1:4000";
  let pendingOrigin: string | null = null;
  return {
    activateConsoleOrigin: vi.fn((origin: string) => { currentOrigin = origin; pendingOrigin = null; }),
    currentConsoleOrigin: vi.fn(() => currentOrigin),
    stageConsoleOrigin: vi.fn((origin: string) => { pendingOrigin = origin; }),
    commitConsoleOrigin: vi.fn(() => { currentOrigin = pendingOrigin!; pendingOrigin = null; }),
    cancelPendingConsoleOrigin: vi.fn(() => { pendingOrigin = null; }),
    admitRemoteConsoleOrigin: vi.fn(),
    withdrawRemoteConsoleOrigin: vi.fn(),
  };
}

function remoteAccessStub(order: string[], overrides: Partial<{ confirmIdentity: () => Promise<void>; join: () => Promise<void>; fetch: (input: string) => Promise<Response>; forget: () => Promise<void> }> = {}) {
  return {
    confirmIdentity: vi.fn(overrides.confirmIdentity ?? (async () => { order.push("confirm"); })),
    pin: vi.fn(() => { order.push("pin"); }),
    unpin: vi.fn(),
    join: vi.fn(overrides.join ?? (async () => { order.push("join"); })),
    fetch: vi.fn(async (input: string) => {
      order.push(`fetch:${input}`);
      return overrides.fetch ? overrides.fetch(input) : identityResponseAt(input);
    }),
    forget: vi.fn(overrides.forget ?? (async () => undefined)),
  };
}

function modalReturning(value: string | null) {
  return { prompt: vi.fn(async () => value) };
}

function identityResponse(): Response {
  return responseAtIdentity(JSON.stringify({ product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 }));
}

function identityResponseAt(url: string): Response {
  const response = new Response(JSON.stringify({ product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 }), { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function responseAtUrl(body: string, url: string): Response {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function responseAtIdentity(body: string, headers?: Record<string, string>): Response {
  const response = new Response(body, { status: 200, headers });
  Object.defineProperty(response, "url", { value: "http://127.0.0.1:4310/api/v1/pairing-identity" });
  return response;
}
