import type { BrowserWindow, WebContents } from "electron";

import type { DesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import type { DesktopFullscreenSynchronizer } from "./desktop-fullscreen-sync.js";
import { pushEntrySnapshot, type EntryPageWebContents } from "./entry-page.js";
import type { PairingModal } from "./pairing-modal.js";
import { isAccessLinkInput, parseAccessLink, type ValidatedAccessLink } from "./remote-access-link.js";
import { snapshotForAccessPhase, snapshotForAccessReady, type RemoteAccessPhase } from "./remote-entry-snapshot.js";
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

/**
 * `typeof fetch`보다 좁게 잡는다. 원격 확인은 Electron 세션의 fetch로 흐르고, 그 쪽은
 * `URL` 입력을 받지 않으므로 전역 fetch 타입을 그대로 요구하면 세션을 넘길 수 없다.
 */
export type ConsoleFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimePairingWindow extends BrowserWindow {
  loadFile(filePath: string): Promise<void>;
  readonly webContents: WebContents & { navigationHistory: { clear(): void } };
}

export interface RuntimePairingNotifier {
  show(options: { readonly title: string; readonly body: string; readonly type: "info" | "error" }): void;
}

/**
 * 원격 접속의 부수효과를 한 곳에 모은 어댑터. 링크를 신뢰 근거로 바꾸는 일(핀 고정)과
 * 자격을 세션으로 바꾸는 일(조인)이 같은 세션 위에서 같은 순서로 일어나야 한다.
 */
export interface RemoteAccessAdapter {
  /** 첫 네트워크 요청보다 반드시 먼저 호출된다. */
  pin(link: ValidatedAccessLink): void;
  unpin(link: ValidatedAccessLink): void;
  join(link: ValidatedAccessLink): Promise<void>;
  /** 조인으로 받은 세션 쿠키가 사는 fetch. 신원 확인도 같은 항아리를 써야 한다. */
  readonly fetch: ConsoleFetch;
  /** 접속을 놓을 때 그 origin의 세션 흔적을 지운다. */
  forget(link: ValidatedAccessLink): Promise<void>;
}

export interface RuntimePairingDependencies {
  readonly fetch?: ConsoleFetch;
  readonly notifier: RuntimePairingNotifier | null;
  readonly fullscreenSynchronizer?: () => DesktopFullscreenSynchronizer | null;
  readonly themeSynchronizer: DesktopThemeSynchronizer | null;
  readonly modal: PairingModal;
  readonly entryPagePath: string;
  readonly localOrigin: () => string | null;
  readonly timeoutMs?: number;
  readonly remoteAccess?: RemoteAccessAdapter;
  readonly logger?: { info(message: string): void; error(message: string): void };
  readonly onRuntimeChanged?: () => void;
}

export interface RuntimePairing {
  prompt(window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
  switchTo(input: string, window: RuntimePairingWindow, policy: WindowPolicy): Promise<void>;
  dispose(): Promise<void>;
}

export type PairingTarget =
  | { readonly kind: "loopback"; readonly origin: string }
  | { readonly kind: "link"; readonly link: ValidatedAccessLink };

export function parsePairingTarget(input: string): PairingTarget {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(input);
  if (match) {
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("pairing_target_invalid");
    return { kind: "loopback", origin: `http://127.0.0.1:${port}` };
  }
  if (!isAccessLinkInput(input)) throw new Error("pairing_target_invalid");
  return { kind: "link", link: parseAccessLink(input) };
}

export async function verifyPairingTarget(input: string, fetchFor: ConsoleFetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  const target = parsePairingTarget(input);
  if (target.kind !== "loopback") throw new Error("pairing_target_invalid");
  return verifyPairingOrigin(target.origin, fetchFor, timeoutMs);
}

export async function verifyPairingOrigin(origin: string, fetchFor: ConsoleFetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("pairing_target_invalid");
  return verifyConsoleIdentity(parsed.origin, fetchFor, timeoutMs);
}

/**
 * 주소가 실제로 호환 Fleet Console인지 확인한다. 원격에서는 조인으로 세션을 연 뒤에만
 * 200이 돌아오므로, 이 확인은 "붙을 수 있다"가 아니라 "붙었고 그 상대가 콘솔이다"를 뜻한다.
 */
export async function verifyConsoleIdentity(origin: string, fetchFor: ConsoleFetch = globalThis.fetch, timeoutMs = PAIRING_TIMEOUT_MS): Promise<{ readonly origin: string; readonly consoleUrl: string }> {
  const identityUrl = new URL(PAIRING_IDENTITY_PATH, `${origin}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFor(identityUrl, { method: "GET", redirect: "error", signal: controller.signal });
    if (!response.ok || response.url !== identityUrl) throw new Error("pairing_target_unverified");
    const payload = parsePairingIdentity(await readBoundedText(response, MAX_PAIRING_IDENTITY_BYTES));
    if (!isPairingIdentity(payload)) throw new Error("pairing_target_unverified");
    return { origin, consoleUrl: new URL("/console/", `${origin}/`).toString() };
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
  let committedLink: ValidatedAccessLink | null = null;
  let switchInFlight = false;

  const releaseLink = async (link: ValidatedAccessLink | null, policy: WindowPolicy): Promise<void> => {
    if (!link || !dependencies.remoteAccess) return;
    try {
      dependencies.remoteAccess.unpin(link);
      policy.withdrawRemoteConsoleOrigin(link.origin);
      await dependencies.remoteAccess.forget(link);
    } catch (error) {
      dependencies.logger?.error(`remote access release failed code=${redactedCode(failureCode(error))}`);
    }
  };

  /**
   * 실패한 후보를 걷어낸다. 같은 원격에 다시 붙다가 실패한 경우에는 살아 있는 접속을
   * 함께 끊어서는 안 되므로, 핀을 실패한 링크가 아니라 커밋된 링크의 값으로 되돌린다.
   */
  const rollbackCandidate = async (candidate: ValidatedAccessLink | null, policy: WindowPolicy): Promise<void> => {
    if (!candidate || !dependencies.remoteAccess) return;
    if (committedLink && committedLink.origin === candidate.origin) {
      dependencies.remoteAccess.pin(committedLink);
      return;
    }
    await releaseLink(candidate, policy);
  };

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
    let candidate: ValidatedAccessLink | null = null;
    let remotePhase: RemoteAccessPhase = "reading_link";
    let entryLoaded = false;
    let entryPush = Promise.resolve();
    const pushRemoteSnapshot = (snapshot: Parameters<typeof pushEntrySnapshot>[1]): void => {
      entryPush = entryPush.then(async () => {
        if (!window.isDestroyed()) await pushEntrySnapshot(window.webContents as EntryPageWebContents, snapshot);
      }).catch((error: unknown) => {
        dependencies.logger?.error(`managed runtime entry snapshot failed code=${redactedCode(failureCode(error))}`);
      });
    };
    const advance = (link: ValidatedAccessLink, phase: RemoteAccessPhase): void => {
      remotePhase = phase;
      pushRemoteSnapshot(snapshotForAccessPhase(link.hostname, phase));
    };
    try {
      const parsed = input === dependencies.localOrigin()
        ? { kind: "loopback" as const, origin: input }
        : parsePairingTarget(input);
      if (parsed.kind === "loopback") target = await verifyPairingOrigin(parsed.origin, fetchFor, timeoutMs);
      else {
        const remote = dependencies.remoteAccess;
        if (!remote) throw new Error("remote_access_unavailable");
        candidate = parsed.link;
        await window.loadFile(dependencies.entryPagePath);
        entryLoaded = true;
        await pushEntrySnapshot(window.webContents, snapshotForAccessPhase(candidate.hostname, remotePhase));
        // 순서가 방어다 — 지문을 고정하기 전에는 이 호스트로 어떤 요청도 나가지 않는다.
        advance(candidate, "pinning_identity");
        remote.pin(candidate);
        advance(candidate, "opening_session");
        await remote.join(candidate);
        advance(candidate, "verifying_console");
        target = await verifyConsoleIdentity(candidate.origin, remote.fetch, timeoutMs);
        policy.admitRemoteConsoleOrigin(candidate.origin);
        pushRemoteSnapshot(snapshotForAccessReady(candidate.hostname));
        await entryPush;
      }
    } catch (error) {
      const localOrigin = dependencies.localOrigin();
      if (candidate && entryLoaded && !window.isDestroyed()) {
        pushRemoteSnapshot(snapshotForAccessPhase(candidate.hostname, remotePhase, true));
        await entryPush;
      }
      await rollbackCandidate(candidate, policy);
      const previousWasRemote = previousOrigin !== null && previousOrigin !== localOrigin;
      let localRestored = true;
      if (candidate && previousOrigin && previousOrigin !== localOrigin && !window.isDestroyed()) {
        await restorePreviousRemoteRuntime(window, policy, previousOrigin, previousUrl, dependencies);
      } else if (candidate && localOrigin && !window.isDestroyed()) {
        localRestored = await restoreLocalRuntime(window, policy, localOrigin, previousUrl, dependencies, async () => {
          const previousLink = committedLink;
          committedLink = null;
          await releaseLink(previousLink, policy);
        });
      }
      logPairingFailure(dependencies, error);
      if (candidate && !previousWasRemote && !localRestored) notifyLocalUnavailable(dependencies.notifier);
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
      const previousLink = committedLink;
      committedLink = candidate;
      if (previousLink && previousLink.origin !== candidate?.origin) await releaseLink(previousLink, policy);
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
      await rollbackCandidate(candidate, policy);
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
        const value = await dependencies.modal.prompt(window);
        if (typeof value === "string" && !window.isDestroyed()) await switchTo(value, window, policy);
      } catch (error) {
        notifyFailure(dependencies.notifier, error);
      }
    })()
      .finally(() => { promptInFlight = null; });
    return promptInFlight;
  };
  return {
    prompt,
    switchTo,
    async dispose() {
      const link = committedLink;
      committedLink = null;
      if (!link || !dependencies.remoteAccess) return;
      try {
        dependencies.remoteAccess.unpin(link);
        await dependencies.remoteAccess.forget(link);
      } catch (error) {
        dependencies.logger?.error(`remote access release failed code=${redactedCode(failureCode(error))}`);
      }
    },
  };
}

async function restoreLocalRuntime(window: RuntimePairingWindow, policy: WindowPolicy, localOrigin: string, previousUrl: string, dependencies: RuntimePairingDependencies, disposePreviousRemote: () => Promise<void>): Promise<boolean> {
  try {
    const local = await verifyPairingOrigin(localOrigin, dependencies.fetch ?? globalThis.fetch, dependencies.timeoutMs ?? PAIRING_TIMEOUT_MS);
    policy.stageConsoleOrigin(local.origin);
    await window.loadURL(previousLocalConsoleUrl(previousUrl, local.origin, local.consoleUrl));
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

function previousLocalConsoleUrl(previousUrl: string, localOrigin: string, fallbackUrl: string): string {
  try {
    const previous = new URL(previousUrl);
    return previous.origin === localOrigin && previous.pathname.startsWith("/console/") ? previous.toString() : fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

async function restorePreviousRemoteRuntime(window: RuntimePairingWindow, policy: WindowPolicy, previousOrigin: string, previousUrl: string, dependencies: RuntimePairingDependencies): Promise<boolean> {
  try {
    policy.activateConsoleOrigin(previousOrigin);
    await window.loadURL(previousUrl);
    if (window.isDestroyed()) throw new Error("pairing_window_destroyed");
    return true;
  } catch (restoreError) {
    dependencies.logger?.error(`managed runtime remote restore failed code=${redactedCode(failureCode(restoreError))}`);
    return false;
  }
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
    case "pairing_target_invalid": return "That is not a Fleet Console access link. Create a new link in the console you want to reach.";
    case "remote_access_unavailable": return "This Fleet Console Desktop cannot open remote links.";
    case "remote_link_rejected": return "The access link was already used or has expired. Create a new one.";
    case "remote_link_host_mismatch": return "The remote console refused this address. Create the link again from that console.";
    case "remote_link_unreachable": return "Could not reach that console, or its certificate did not match the link.";
    case "remote_link_unverified": return "The remote console refused the access link.";
    case "window_policy_remote_origin_invalid": return "That access link points at an address Fleet Console will not open.";
    case "pairing_target_unverified": return "That address is not a compatible Fleet Console runtime.";
    case "pairing_target_unavailable": return "Could not reach that Fleet Console. Check that it is still running.";
    default: return "The connection failed. Local Fleet Console remains available.";
  }
}
function redactedCode(value: string): string { return /^[a-z0-9_]+$/u.test(value) ? value : "pairing_failed"; }
