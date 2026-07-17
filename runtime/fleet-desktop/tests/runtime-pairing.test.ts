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
    const pairing = createRuntimePairing({ notifier, themeSynchronizer: theme as never, modal: modalReturning(null), fetch: async () => identityResponse() });
    await pairing.switchTo("127.0.0.1:4310", window as never, policy);
    expect(order).toEqual(["stage", "load", "commit", "theme-stop", "theme-start", "notification"]);
    expect(window.webContents.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("rolls back the pending origin and restores the previous page before reporting failure", async () => {
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const notifier = { show: vi.fn() };
    const loadURL = vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValueOnce(undefined);
    const window = runtimeWindow(loadURL);
    const pairing = createRuntimePairing({ notifier, themeSynchronizer: null, modal: modalReturning(null), fetch: async () => identityResponse() });
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
    const pairing = createRuntimePairing({ notifier, themeSynchronizer: theme as never, modal: modalReturning(null), fetch: async () => identityResponse() });

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

  it("serializes the Desktop modal prompt and sends its raw target through the existing verifier", async () => {
    let resolvePrompt: ((value: string | null) => void) | undefined;
    const modal = { prompt: vi.fn(() => new Promise<string | null>((resolve) => { resolvePrompt = resolve; })) };
    const loadURL = vi.fn(async () => undefined);
    const pairing = createRuntimePairing({ notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: async () => identityResponse() });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const window = runtimeWindow(loadURL);

    const first = pairing.prompt(window as never, policy);
    const second = pairing.prompt(window as never, policy);
    expect(modal.prompt).toHaveBeenCalledOnce();
    resolvePrompt?.("127.0.0.1:4310");
    await Promise.all([first, second]);
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
  });

  it("commits a verified SSH candidate before replacing the prior remote session and remembers only that commit", async () => {
    const order: string[] = [];
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(() => { order.push("candidate-commit"); }), rollback: vi.fn(async () => { order.push("candidate-rollback"); }), dispose: vi.fn(async () => { order.push("candidate-dispose"); }) };
    const store = { load: vi.fn(() => null), save: vi.fn(() => order.push("save")) };
    const pairing = createRuntimePairing({ notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), lastTargetStore: store, connectRemote: vi.fn(async () => candidate), fetch: async () => identityResponse() });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(() => order.push("stage")), commitConsoleOrigin: vi.fn(() => order.push("policy-commit")), cancelPendingConsoleOrigin: vi.fn() };
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => { order.push("load"); }) as never, policy);
    await pairing.switchTo("127.0.0.1:4310", runtimeWindow(async () => { order.push("local-load"); }) as never, policy);
    expect(order).toEqual(["stage", "load", "policy-commit", "candidate-commit", "save", "stage", "local-load", "policy-commit", "candidate-dispose"]);
    expect(candidate.rollback).not.toHaveBeenCalled();
  });

  it("rolls back only the SSH candidate when pairing verification fails and does not persist it", async () => {
    const candidate = { target: { value: "devbox", user: null, host: "devbox" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), rollback: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const store = { load: vi.fn(() => null), save: vi.fn() };
    const pairing = createRuntimePairing({ notifier: { show: vi.fn() }, themeSynchronizer: null, modal: modalReturning(null), lastTargetStore: store, connectRemote: async () => candidate, fetch: async () => responseAtIdentity("{}") });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(candidate.rollback).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
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
    const pairing = createRuntimePairing({ notifier, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => { throw Object.assign(new Error("redacted"), { code }); } });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body, type: "error" });
  });

  it("keeps unknown failure details out of the user-facing message", async () => {
    const notifier = { show: vi.fn() };
    const pairing = createRuntimePairing({ notifier, themeSynchronizer: null, modal: modalReturning(null), connectRemote: async () => { throw new Error("ssh /Users/alice/.ssh/config token=secret"); } });
    await pairing.switchTo("ssh:devbox", runtimeWindow(async () => undefined) as never, { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(() => "http://127.0.0.1:4000"), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() });
    expect(notifier.show).toHaveBeenCalledWith({ title: "Fleet Console connection failed", body: "The connection failed. The previous Fleet Console runtime remains connected.", type: "error" });
  });

  it("does not prompt a destroyed parent window", async () => {
    const modal = modalReturning("127.0.0.1:4310");
    const pairing = createRuntimePairing({ notifier: { show: vi.fn() }, themeSynchronizer: null, modal, fetch: vi.fn() });
    const policy = { activateConsoleOrigin: vi.fn(), currentConsoleOrigin: vi.fn(), stageConsoleOrigin: vi.fn(), commitConsoleOrigin: vi.fn(), cancelPendingConsoleOrigin: vi.fn() };
    const window = { ...runtimeWindow(vi.fn()), isDestroyed: () => true };
    await pairing.prompt(window as never, policy);
    expect(modal.prompt).not.toHaveBeenCalled();
  });
});

function runtimeWindow(loadURL: (url: string) => Promise<void>) {
  return {
    isDestroyed: () => false,
    loadURL,
    webContents: {
      getURL: () => "http://127.0.0.1:4000/console/",
      navigationHistory: { clear: vi.fn() },
    },
  };
}

function modalReturning(value: string | null) {
  return { prompt: vi.fn(async () => value) };
}

function identityResponse(): Response {
  return responseAtIdentity(JSON.stringify({ product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 }));
}

function responseAtIdentity(body: string, headers?: Record<string, string>): Response {
  const response = new Response(body, { status: 200, headers });
  Object.defineProperty(response, "url", { value: "http://127.0.0.1:4310/api/v1/pairing-identity" });
  return response;
}
