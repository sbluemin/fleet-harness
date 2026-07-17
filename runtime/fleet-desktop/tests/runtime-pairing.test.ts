import { describe, expect, it, vi } from "vitest";

import { createRuntimePairing, parsePairingTarget, verifyPairingTarget } from "../src/runtime-pairing.js";

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

  it("stages, commits, and notifies only after the target Console loads", async () => {
    const order: string[] = [];
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(() => order.push("stage")), commitConsoleOrigin: vi.fn(() => order.push("commit")), cancelPendingConsoleOrigin: vi.fn(() => order.push("cancel")) };
    const notifier = { show: vi.fn(() => order.push("notification")) };
    const theme = { stop: vi.fn(() => order.push("theme-stop")), start: vi.fn(async () => { order.push("theme-start"); }) };
    const window = runtimeWindow(async () => { order.push("load"); });
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: theme as never, modal: modalReturning(null), fetch: async () => identityResponse() });
    await pairing.switchTo("127.0.0.1:4310", window as never, policy);
    expect(order).toEqual(["stage", "load", "commit", "theme-stop", "theme-start", "notification"]);
    expect(window.webContents.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("rolls back the pending origin and restores the previous page before reporting failure", async () => {
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
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
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
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
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const fullscreen = { activate: vi.fn(), reset: vi.fn(), resync: vi.fn(), stop: vi.fn() };
    const pairing = createRuntimePairing({
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

  it("captures the local Console URL before the SSH entry page replaces it and restores that URL after remote handoff failure", async () => {
    let currentUrl = "http://127.0.0.1:4000/console/";
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const loadURL = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:4310/console/") throw new Error("remote handoff failed");
      currentUrl = url;
    });
    const window = runtimeWindow(loadURL);
    window.webContents.getURL = () => currentUrl;
    window.loadFile.mockImplementation(async () => { currentUrl = "file:///entry/index.html"; });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => candidate });

    await pairing.switchTo("ssh:devbox", window as never, policy);

    expect(loadURL).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4310/console/");
    expect(loadURL).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4000/console/");
  });

  it("ignores concurrent switch requests while an SSH transition is in flight", async () => {
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    let resolveRemote: (() => void) | undefined;
    const connectRemote = vi.fn(() => new Promise<typeof candidate>((resolve) => { resolveRemote = () => resolve(candidate); }));
    const logger = { info: vi.fn(), error: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), connectRemote, logger });
    const window = runtimeWindow(async () => undefined);
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };

    const first = pairing.switchTo("ssh:devbox", window as never, policy);
    await vi.waitFor(() => expect(connectRemote).toHaveBeenCalledOnce());
    await pairing.switchTo("http://127.0.0.1:4000", window as never, policy);
    resolveRemote?.();
    await first;

    expect(logger.info).toHaveBeenCalledWith("managed runtime pairing ignored code=transition_in_progress");
    expect(policy.stageConsoleOrigin).toHaveBeenCalledOnce();
  });

  it("does not publish the ready handoff snapshot when final remote identity verification fails", async () => {
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const window = runtimeWindow(async () => undefined);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => candidate, fetch: async () => responseAtIdentity("{}") });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };

    await pairing.switchTo("ssh:devbox", window as never, policy);

    const entryScripts = window.webContents.executeJavaScript.mock.calls as unknown as readonly (readonly string[])[];
    expect(entryScripts.some(([source]) => source?.includes("Console ready"))).toBe(false);
  });

  it("serializes the Desktop modal prompt and sends its raw target through the existing verifier", async () => {
    let resolvePrompt: ((value: string | null) => void) | undefined;
    const modal = { prompt: vi.fn(() => new Promise<string | null>((resolve) => { resolvePrompt = resolve; })) };
    const loadURL = vi.fn(async () => undefined);
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: async () => identityResponse() });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const window = runtimeWindow(loadURL);

    const first = pairing.prompt(window as never, policy);
    const second = pairing.prompt(window as never, policy);
    expect(modal.prompt).toHaveBeenCalledOnce();
    resolvePrompt?.("127.0.0.1:4310");
    await Promise.all([first, second]);
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
  });

  it("returns from a committed remote session to the local runtime and disposes that remote session", async () => {
    const order: string[] = [];
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(() => { order.push("candidate-commit"); }), rollback: vi.fn(async () => { order.push("candidate-rollback"); }), dispose: vi.fn(async () => { order.push("candidate-dispose"); }) };
    const store = { load: vi.fn(() => null), save: vi.fn(() => order.push("save")) };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), lastTargetStore: store, connectRemote: vi.fn(async () => candidate) });
    let currentOrigin = "http://127.0.0.1:4000";
    let pendingOrigin: string | null = null;
    const policy = {
      activateConsoleOrigin: vi.fn((origin: string) => { currentOrigin = origin; pendingOrigin = null; }),
      currentConsoleOrigin: vi.fn(() => currentOrigin),
      stageConsoleOrigin: vi.fn((origin: string) => { order.push("stage"); pendingOrigin = origin; }),
      commitConsoleOrigin: vi.fn(() => { order.push("policy-commit"); currentOrigin = pendingOrigin!; pendingOrigin = null; }),
      cancelPendingConsoleOrigin: vi.fn(),
    };
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => { order.push("load"); }) as never, policy);
    await pairing.switchTo("http://127.0.0.1:4000", runtimeWindow(async () => { order.push("local-load"); }) as never, policy);
    expect(order).toEqual(["stage", "load", "policy-commit", "candidate-commit", "save", "stage", "local-load", "policy-commit", "candidate-dispose"]);
    expect(candidate.rollback).not.toHaveBeenCalled();
    expect(policy.currentConsoleOrigin()).toBe("http://127.0.0.1:4000");
  });

  it("keeps a committed remote session when a later remote candidate fails", async () => {
    const remoteA = { target: { value: "remote-a", user: null, host: "remote-a" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const candidateB = { target: { value: "remote-b", user: null, host: "remote-b" }, origin: "http://127.0.0.1:4320", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    let currentOrigin = "http://127.0.0.1:4000";
    let pendingOrigin: string | null = null;
    const policy = {
      activateConsoleOrigin: vi.fn((origin: string) => { currentOrigin = origin; pendingOrigin = null; }),
      currentConsoleOrigin: vi.fn(() => currentOrigin),
      stageConsoleOrigin: vi.fn((origin: string) => { pendingOrigin = origin; }),
      commitConsoleOrigin: vi.fn(() => { currentOrigin = pendingOrigin!; pendingOrigin = null; }),
      cancelPendingConsoleOrigin: vi.fn(() => { pendingOrigin = null; }),
    };
    const connectRemote = vi.fn(async () => connectRemote.mock.calls.length === 1 ? remoteA : candidateB);
    const fetch = async (input: unknown) => {
      const url = String(input);
      return url.includes(":4310/") ? identityResponseAt(url) : responseAtUrl("{}", url);
    };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), connectRemote, fetch });
    await pairing.switchTo("ssh:remote-a", runtimeWindow(async () => undefined) as never, policy);
    const remoteLoadURL = vi.fn(async () => undefined);
    const remoteWindow = runtimeWindow(remoteLoadURL);
    remoteWindow.loadFile.mockImplementation(async () => undefined);
    remoteWindow.webContents.getURL = () => "http://127.0.0.1:4310/console/";

    await pairing.switchTo("ssh:remote-b", remoteWindow as never, policy);

    expect(candidateB.rollback).toHaveBeenCalledOnce();
    expect(remoteA.dispose).not.toHaveBeenCalled();
    expect(remoteLoadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
    expect(policy.activateConsoleOrigin).toHaveBeenCalledWith("http://127.0.0.1:4310");
    expect(policy.currentConsoleOrigin()).toBe("http://127.0.0.1:4310");
  });

  it("shows remote bootstrap progress, then returns to the durable local runtime and reports the failure", async () => {
    const order: string[] = [];
    const notifier = { show: vi.fn(() => order.push("failure-dialog")) };
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(() => order.push("stage-local")), commitConsoleOrigin: vi.fn(() => order.push("commit-local")), cancelPendingConsoleOrigin: vi.fn() };
    const window = runtimeWindow(async (url) => { order.push(`load:${url}`); });
    window.loadFile.mockImplementation(async () => { order.push("entry"); });
    window.webContents.executeJavaScript.mockImplementation(async () => { order.push("snapshot"); });
    const pairing = createRuntimePairing({
      ...pairingDefaults(),
      notifier,
      themeSynchronizer: null,
      modal: modalReturning(null),
      fetch: async (input) => identityResponseAt(String(input)),
      connectRemote: async (_target, onPhase) => {
        onPhase("opening_tunnel");
        throw Object.assign(new Error("redacted"), { code: "ssh_failed" });
      },
    });

    await pairing.switchTo("ssh:devbox", window as never, policy);

    expect(order).toEqual(expect.arrayContaining(["entry", "snapshot", "stage-local", "load:http://127.0.0.1:4000/console/", "commit-local", "failure-dialog"]));
    const entryScripts = window.webContents.executeJavaScript.mock.calls as unknown as readonly (readonly string[])[];
    expect(entryScripts.at(-1)?.[0]).toContain('"state":"failed"');
    expect(order.lastIndexOf("snapshot")).toBeLessThan(order.indexOf("load:http://127.0.0.1:4000/console/"));
    expect(order.indexOf("commit-local")).toBeLessThan(order.indexOf("failure-dialog"));
  });

  it("rolls back only the SSH candidate when pairing verification fails and does not persist it", async () => {
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const store = { load: vi.fn(() => null), save: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), lastTargetStore: store, connectRemote: async () => candidate, fetch: async () => responseAtIdentity("{}") });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(candidate.rollback).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("reports an unavailable local runtime instead of claiming it remains available", async () => {
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => { throw Object.assign(new Error("redacted"), { code: "ssh_failed" }); }, fetch: async () => responseAtIdentity("{}") });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "Local Fleet Console is unavailable. Restart Fleet Console.", type: "error" });
  });

  it("logs remote disposal failures after a successful local return", async () => {
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => { throw new Error("dispose failed"); }) };
    const logger = { info: vi.fn(), error: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => candidate, logger });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };

    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, policy);
    await pairing.switchTo("http://127.0.0.1:4000", runtimeWindow(async () => undefined) as never, policy);

    expect(logger.error).toHaveBeenCalledWith("managed runtime dispose failed code=pairing_failed");
  });

  it.each([
    ["remote_platform_unsupported", "The remote machine runs an unsupported OS or CPU architecture."],
    ["ssh_unavailable", "OpenSSH (ssh) was not found on this machine."],
    ["ssh_failed", "Could not reach the remote host. Check the address and your SSH config and agent."],
    ["pairing_target_unavailable", "Could not reach the remote host. Check the address and your SSH config and agent."],
    ["ssh_timeout", "The SSH connection timed out."],
    ["remote_console_owned_elsewhere", "Another Fleet Console Desktop is already using that remote runtime."],
    ["remote_console_lock_conflict", "The remote runtime is in use by another process."],
    ["remote_tunnel_port_conflict_exhausted", "Could not find a free local port for the tunnel after several attempts."],
    ["remote_node_invalid", "The remote runtime failed its integrity check."],
    ["remote_console_invalid", "The remote runtime failed its integrity check."],
    ["remote_registry_unavailable", "Could not reach the package registry to install Fleet Console."],
    ["pairing_target_unverified", "That address is not a compatible Fleet Console runtime."],
  ])("shows a safe, actionable message for %s", async (code, body) => {
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => { throw Object.assign(new Error("redacted"), { code }); } });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body, type: "error" });
  });

  it("keeps unknown failure details out of the user-facing message", async () => {
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => { throw new Error("ssh /Users/alice/.ssh/config token=secret"); } });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "The connection failed. Local Fleet Console remains available.", type: "error" });
  });

  it("does not prompt a destroyed parent window", async () => {
    const modal = modalReturning("127.0.0.1:4310");
    const pairing = createRuntimePairing({ ...pairingDefaults(), notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: vi.fn() });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const window = { ...runtimeWindow(vi.fn()), isDestroyed: () => true };
    await pairing.prompt(window as never, policy);
    expect(modal.prompt).not.toHaveBeenCalled();
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
  return { entryPagePath: "/entry.html", localOrigin: () => "http://127.0.0.1:4000", fetch: async (input: unknown) => identityResponseAt(String(input)) };
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
