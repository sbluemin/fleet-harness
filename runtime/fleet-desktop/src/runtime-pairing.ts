import type { BrowserWindow, WebContents } from "electron";

import type { DesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import type { DesktopFullscreenSynchronizer } from "./desktop-fullscreen-sync.js";
import type { PairingModal } from "./pairing-modal.js";
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
  readonly timeoutMs?: number;
}

export interface RuntimePairing {
  prompt(window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
  switchTo(input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
}

export function parsePairingTarget(input: string): URL {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(input);
  if (!match) throw new Error("pairing_target_invalid");
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("pairing_target_invalid");
  return new URL(`http://127.0.0.1:${port}`);
}

export async function verifyPairingTarget(input: string, fetchFor: typeof fetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  return verifyPairingOrigin(parsePairingTarget(input).origin, fetchFor, timeoutMs);
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

  const switchTo = async (input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void> => {
    let target: { readonly origin: string; readonly consoleUrl: string };
    try {
      target = await verifyPairingTarget(input, fetchFor, timeoutMs);
    } catch (error) {
      notifyFailure(dependencies.notifier, error);
      return;
    }
    const previousUrl = window.webContents.getURL();
    const previousOrigin = policy.currentConsoleOrigin();
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
      dependencies.fullscreenSynchronizer?.()?.resync();
      notifyFailure(dependencies.notifier, error);
    }
  };

  const prompt = (window: RuntimePairingWindow, policy: WindowPolicy): Promise<void> => {
    if (promptInFlight) return promptInFlight;
    promptInFlight = (async () => {
      if (window.isDestroyed()) return;
      try {
        const value = await dependencies.modal.prompt(window);
        if (typeof value === "string" && !window.isDestroyed()) await switchTo(value, window, policy);
      } catch (error) {
        notifyFailure(dependencies.notifier, error);
      }
    })()
      .finally(() => { promptInFlight = null; });
    return promptInFlight;
  };
  return { prompt, switchTo };
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
  const code = error instanceof Error ? error.message : "pairing_failed";
  notifier?.show({ title: "Fleet Console connection failed", body: code === "pairing_target_unverified" ? "That address is not a compatible Fleet Console runtime." : "The previous Fleet Console runtime remains connected.", type: "error" });
}
