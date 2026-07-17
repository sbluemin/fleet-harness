import type { BrowserWindow, WebContents } from "electron";

import type { DesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import type { DesktopFullscreenSynchronizer } from "./desktop-fullscreen-sync.js";
import { pushEntrySnapshot, type EntryPageWebContents } from "./entry-page.js";
import type { PairingModal } from "./pairing-modal.js";
import { snapshotForRemotePhase, snapshotForRemoteReady } from "./remote-entry-snapshot.js";
import type { RemoteRuntimePhase } from "./runtime/remote/contracts.js";
import { parseSshTarget, type ValidatedSshTarget } from "./runtime/remote/target.js";
import type { ManagedRemoteSession } from "./runtime/remote/orchestrator.js";
import type { RemoteLastTargetStore } from "./runtime/remote/last-target.js";
import type { WindowPolicy } from "./window-policy.js";

export const PAIRING_IDENTITY_PATH = "/api/v1/pairing-identity";
export const PAIRING_PROTOCOL_VERSION = 1;
const PAIRING_TIMEOUT_MS = 3_000;
const MAX_PAIRING_IDENTITY_BYTES = 8 * 1024;

export interface PairingIdentity {
  readonly product: "fleet-console";
  readonly schemaVersion: 1;
  readonly pairingProtocolVersion: 1;
}

export interface RuntimePairingWindow extends BrowserWindow {
  loadFile(filePath: string): Promise<void>;
  readonly webContents: WebContents & { navigationHistory: { clear(): void } };
}

export interface RuntimePairingNotifier {
  show(options: { readonly title: string; readonly body: string; readonly type: "info" | "error" }): void;
}

export interface RuntimePairingDependencies {
  readonly fetch?: typeof fetch;
  readonly notifier: RuntimePairingNotifier | null;
  readonly fullscreenSynchronizer?: () => DesktopFullscreenSynchronizer | null;
  readonly themeSynchronizer: DesktopThemeSynchronizer | null;
  readonly modal: PairingModal;
  readonly entryPagePath: string;
  readonly localOrigin: () => string | null;
  readonly timeoutMs?: number;
  readonly connectRemote?: (target: ValidatedSshTarget, onPhase: (phase: RemoteRuntimePhase) => void) => Promise<ManagedRemoteSession>;
  readonly lastTargetStore?: RemoteLastTargetStore;
  readonly logger?: { info(message: string): void; error(message: string): void };
  readonly onRuntimeChanged?: () => void;
}

export interface RuntimePairing {
  prompt(window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
  switchTo(input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
  dispose(): Promise<void>;
}

export type PairingTarget = { readonly kind: "loopback"; readonly origin: string } | { readonly kind: "ssh"; readonly target: ValidatedSshTarget };

export function parsePairingTarget(input: string): PairingTarget {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(input);
  if (match) {
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("pairing_target_invalid");
    return { kind: "loopback", origin: `http://127.0.0.1:${port}` };
  }
  if (!input.startsWith("ssh:")) throw new Error("pairing_target_invalid");
  try { return { kind: "ssh", target: parseSshTarget(input.slice(4)) }; } catch { throw new Error("pairing_target_invalid"); }
}

export async function verifyPairingTarget(input: string, fetchFor: typeof fetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  const target = parsePairingTarget(input);
  if (target.kind !== "loopback") throw new Error("pairing_target_invalid");
  return verifyPairingOrigin(target.origin, fetchFor, timeoutMs);
}

export async function verifyPairingOrigin(origin: string, fetchFor: typeof fetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("pairing_target_invalid");
  const canonicalOrigin = parsed.origin;
  const identityUrl = new URL(PAIRING_IDENTITY_PATH, `${canonicalOrigin}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFor(identityUrl, { method: "GET", redirect: "error", signal: controller.signal });
    if (!response.ok || response.url !== identityUrl) throw new Error("pairing_target_unverified");
    const payload = parsePairingIdentity(await readBoundedText(response, MAX_PAIRING_IDENTITY_BYTES));
    if (!isPairingIdentity(payload)) throw new Error("pairing_target_unverified");
    return { origin: canonicalOrigin, consoleUrl: new URL("/console/", `${canonicalOrigin}/`).toString() };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pairing_target_")) throw error;
    throw new Error("pairing_target_unavailable", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function createRuntimePairing(dependencies: RuntimePairingDependencies): RuntimePairing {
  const fetchFor = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? PAIRING_TIMEOUT_MS;
  let promptInFlight: Promise<void> | null = null;
  let committedRemote: ManagedRemoteSession | null = null;
  let switchInFlight = false;

  const switchTo = async (input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void> => {
    if (switchInFlight) {
      dependencies.logger?.info("managed runtime pairing ignored code=transition_in_progress");
      return;
    }
    switchInFlight = true;
    try { await switchToInternal(input, window, policy); } finally { switchInFlight = false; }
  };

  const switchToInternal = async (input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void> => {
    const previousUrl = window.webContents.getURL();
    const previousOrigin = policy.currentConsoleOrigin();
    let target: { readonly origin: string; readonly consoleUrl: string };
    let candidate: ManagedRemoteSession | null = null;
    let remoteTarget: ValidatedSshTarget | null = null;
    let remotePhase: RemoteRuntimePhase = "validating_target";
    let entryLoaded = false;
    let entryPush = Promise.resolve();
    const pushRemoteSnapshot = (snapshot: Parameters<typeof pushEntrySnapshot>[1]): void => {
      entryPush = entryPush.then(async () => {
        if (!window.isDestroyed()) await pushEntrySnapshot(window.webContents as EntryPageWebContents, snapshot);
      }).catch((error: unknown) => {
        dependencies.logger?.error(`managed runtime entry snapshot failed code=${redactedCode(failureCode(error))}`);
      });
    };
    try {
      const parsed = input === dependencies.localOrigin()
        ? { kind: "loopback" as const, origin: input }
        : parsePairingTarget(input);
      if (parsed.kind === "loopback") target = await verifyPairingOrigin(parsed.origin, fetchFor, timeoutMs);
      else {
        if (!dependencies.connectRemote) throw new Error("ssh_unavailable");
        remoteTarget = parsed.target;
        await window.loadFile(dependencies.entryPagePath);
        entryLoaded = true;
        await pushEntrySnapshot(window.webContents, snapshotForRemotePhase(remoteTarget, remotePhase));
        candidate = await dependencies.connectRemote(remoteTarget, (phase) => {
          remotePhase = phase;
          pushRemoteSnapshot(snapshotForRemotePhase(remoteTarget!, phase));
        });
        target = await verifyPairingOrigin(candidate.origin, fetchFor, timeoutMs);
        pushRemoteSnapshot(snapshotForRemoteReady(remoteTarget));
        await entryPush;
      }
    } catch (error) {
      await candidate?.rollback().catch(() => undefined);
      const localOrigin = dependencies.localOrigin();
      if (remoteTarget && entryLoaded && !window.isDestroyed()) {
        pushRemoteSnapshot(snapshotForRemotePhase(remoteTarget, remotePhase, true));
        await entryPush;
      }
      const localRestored = !remoteTarget || !localOrigin || window.isDestroyed() || await restoreLocalRuntime(window, policy, localOrigin, dependencies, () => {
        const previousRemote = committedRemote;
        committedRemote = null;
        return disposeRemoteSession(previousRemote, dependencies);
      });
      logPairingFailure(dependencies, error);
      if (remoteTarget && !localRestored) notifyLocalUnavailable(dependencies.notifier);
      else notifyFailure(dependencies.notifier, error);
      return;
    }
    let committed = false;
    policy.stageConsoleOrigin(target.origin);
    try {
      await window.loadURL(target.consoleUrl);
      if (window.isDestroyed()) throw new Error("pairing_window_destroyed");
      policy.commitConsoleOrigin();
      committed = true;
      dependencies.themeSynchronizer?.stop();
      await dependencies.themeSynchronizer?.start(target.origin);
      dependencies.fullscreenSynchronizer?.()?.activate(target.origin);
      if (previousOrigin && previousOrigin !== target.origin) dependencies.fullscreenSynchronizer?.()?.reset(previousOrigin);
      window.webContents.navigationHistory.clear();
      candidate?.commit();
      const previousRemote = committedRemote;
      committedRemote = candidate;
      if (candidate) dependencies.lastTargetStore?.save(`ssh:${candidate.target.value}`);
      await disposeRemoteSession(previousRemote, dependencies);
      dependencies.onRuntimeChanged?.();
      dependencies.notifier?.show({ title: "Fleet Console connected", body: `Connected to ${target.origin}.`, type: "info" });
    } catch (error) {
      policy.cancelPendingConsoleOrigin();
      if (committed && previousOrigin) policy.activateConsoleOrigin(previousOrigin);
      if (!window.isDestroyed() && previousUrl) {
        try { await window.loadURL(previousUrl); } catch { /* best-effort restore before reporting failure */ }
      }
      if (committed && previousOrigin) {
        try { await dependencies.themeSynchronizer?.start(previousOrigin); } catch { /* rollback feedback must not hide the original failure */ }
        dependencies.fullscreenSynchronizer?.()?.activate(previousOrigin);
      }
      await candidate?.rollback().catch(() => undefined);
      dependencies.fullscreenSynchronizer?.()?.resync();
      logPairingFailure(dependencies, error);
      notifyFailure(dependencies.notifier, error);
    }
  };

  const prompt = (window: RuntimePairingWindow, policy: WindowPolicy): Promise<void> => {
    if (promptInFlight) return promptInFlight;
    promptInFlight = (async () => {
      if (window.isDestroyed()) return;
      try {
        const value = await dependencies.modal.prompt(window, dependencies.lastTargetStore?.load() ?? null);
        if (typeof value === "string" && !window.isDestroyed()) await switchTo(value, window, policy);
      } catch (error) {
        notifyFailure(dependencies.notifier, error);
      }
    })()
      .finally(() => { promptInFlight = null; });
    return promptInFlight;
  };
  return { prompt, switchTo, async dispose() { const remote = committedRemote; committedRemote = null; await remote?.dispose(); } };
}

async function restoreLocalRuntime(window: RuntimePairingWindow, policy: WindowPolicy, localOrigin: string, dependencies: RuntimePairingDependencies, disposePreviousRemote: () => Promise<void>): Promise<boolean> {
  try {
    const local = await verifyPairingOrigin(localOrigin, dependencies.fetch ?? globalThis.fetch, dependencies.timeoutMs ?? PAIRING_TIMEOUT_MS);
    policy.stageConsoleOrigin(local.origin);
    await window.loadURL(local.consoleUrl);
    if (window.isDestroyed()) throw new Error("pairing_window_destroyed");
    policy.commitConsoleOrigin();
    dependencies.themeSynchronizer?.stop();
    await dependencies.themeSynchronizer?.start(local.origin);
    window.webContents.navigationHistory.clear();
    await disposePreviousRemote();
    dependencies.onRuntimeChanged?.();
    return true;
  } catch (restoreError) {
    policy.cancelPendingConsoleOrigin();
    dependencies.logger?.error(`managed runtime local restore failed code=${redactedCode(failureCode(restoreError))}`);
    return false;
  }
}

async function disposeRemoteSession(session: ManagedRemoteSession | null, dependencies: RuntimePairingDependencies): Promise<void> {
  try { await session?.dispose(); } catch (error) { dependencies.logger?.error(`managed runtime dispose failed code=${redactedCode(failureCode(error))}`); }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new Error("pairing_target_response_too_large");
  if (!response.body) throw new Error("pairing_target_unverified");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("pairing_target_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(concatChunks(chunks, size));
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parsePairingIdentity(body: string): unknown { try { return JSON.parse(body); } catch { return null; } }

function isPairingIdentity(value: unknown): value is PairingIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 3 && entry.product === "fleet-console" && entry.schemaVersion === 1 && entry.pairingProtocolVersion === PAIRING_PROTOCOL_VERSION;
}

function notifyFailure(notifier: RuntimePairingNotifier | null, error: unknown): void {
  notifier?.show({ title: "Fleet Console connection failed", body: failureMessage(failureCode(error)), type: "error" });
}

function notifyLocalUnavailable(notifier: RuntimePairingNotifier | null): void {
  notifier?.show({ title: "Fleet Console connection failed", body: "Local Fleet Console is unavailable. Restart Fleet Console.", type: "error" });
}

function logPairingFailure(dependencies: RuntimePairingDependencies, error: unknown): void {
  dependencies.logger?.error(`managed runtime pairing failed code=${redactedCode(failureCode(error))}`);
}
function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : "pairing_failed";
}
function failureMessage(code: string): string {
  switch (code) {
    case "remote_platform_unsupported": return "The remote machine runs an unsupported OS or CPU architecture.";
    case "ssh_unavailable": return "OpenSSH (ssh) was not found on this machine.";
    case "ssh_failed": case "pairing_target_unavailable": return "Could not reach the remote host. Check the address and your SSH config and agent.";
    case "ssh_timeout": return "The SSH connection timed out.";
    case "remote_console_owned_elsewhere": return "Another Fleet Console Desktop is already using that remote runtime.";
    case "remote_console_lock_conflict": return "The remote runtime is in use by another process.";
    case "remote_tunnel_port_conflict_exhausted": return "Could not find a free local port for the tunnel after several attempts.";
    case "remote_node_invalid": case "remote_console_invalid": return "The remote runtime failed its integrity check.";
    case "remote_registry_unavailable": return "Could not reach the package registry to install Fleet Console.";
    case "pairing_target_unverified": return "That address is not a compatible Fleet Console runtime.";
    default: return "The connection failed. Local Fleet Console remains available.";
  }
}
function redactedCode(value: string): string { return /^[a-z0-9_]+$/u.test(value) ? value : "pairing_failed"; }
