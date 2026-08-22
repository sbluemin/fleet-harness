import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import type { BrowserWindow, WebContents } from "electron";

const DESKTOP_FULLSCREEN_PATH = "/api/v1/desktop/fullscreen";
const MAX_TRANSIENT_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 1_000;

export interface DesktopFullscreenWindow extends Pick<BrowserWindow, "isFullScreen"> {
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): this;
  removeListener(event: "enter-full-screen" | "leave-full-screen", listener: () => void): this;
  readonly webContents: Pick<WebContents, "on" | "removeListener">;
}

export interface DesktopFullscreenSynchronizer {
  activate(origin: string): void;
  reset(origin: string): void;
  resync(): void;
  stop(): void;
}

export interface DesktopFullscreenSynchronizerDeps {
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Tracks the native BrowserWindow state from creation, but does not publish
 * until a verified Console origin has completed handoff or pairing.
 */
export function createDesktopFullscreenSynchronizer(
  window: DesktopFullscreenWindow,
  deps: DesktopFullscreenSynchronizerDeps = {},
): DesktopFullscreenSynchronizer {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancelSchedule = deps.clearTimeout ?? globalThis.clearTimeout;
  const webContents = window.webContents;
  let nativeFullscreen = window.isFullScreen();
  let activeOrigin: string | null = null;
  let unsupported = false;
  let activePublication: { readonly origin: string; readonly fullscreen: boolean } | null = null;
  let publishPending = false;
  let stopped = false;
  const originTails = new Map<string, Promise<void>>();
  const activeControllers = new Map<string, Set<AbortController>>();

  const enqueue = <T>(origin: string, action: () => Promise<T>): Promise<T> => {
    const previous = originTails.get(origin) ?? Promise.resolve();
    const scheduled = previous.catch(() => undefined).then(action);
    const tail = scheduled.then(() => undefined, () => undefined);
    originTails.set(origin, tail);
    void tail.finally(() => {
      if (originTails.get(origin) === tail) originTails.delete(origin);
    });
    return scheduled;
  };

  const publishWithRetry = async (origin: string, fullscreen: boolean, shouldStop: () => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      if (shouldStop()) return false;
      const controller = new AbortController();
      const controllers = activeControllers.get(origin) ?? new Set<AbortController>();
      controllers.add(controller);
      activeControllers.set(origin, controllers);
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const request = fetchFor(new URL(DESKTOP_FULLSCREEN_PATH, `${origin}/`).toString(), {
          method: "PUT",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ fullscreen }),
          signal: controller.signal,
        });
        void request.catch(() => undefined);
        const response = await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = schedule(() => {
              controller.abort();
              reject(new Error("desktop_fullscreen_request_timeout"));
            }, requestTimeoutMs);
          }),
        ]);
        if (response.status === 404 || response.status === 405) return true;
        if (response.ok) return false;
      } catch {
        // Timeout and abort are transient unless a newer state or stop supersedes this attempt.
      } finally {
        if (timeout !== null) cancelSchedule(timeout);
        controllers.delete(controller);
        if (controllers.size === 0) activeControllers.delete(origin);
      }
    }
    return false;
  };

  const abortRequestsExcept = (origin: string) => {
    for (const [requestOrigin, controllers] of activeControllers) {
      if (requestOrigin === origin) continue;
      for (const controller of controllers) controller.abort();
    }
  };

  const abortAllRequests = () => {
    for (const controllers of activeControllers.values()) {
      for (const controller of controllers) controller.abort();
    }
  };

  const publishCurrent = () => {
    if (stopped || !activeOrigin || unsupported) return;
    if (activePublication?.origin === activeOrigin) {
      publishPending = true;
      return;
    }
    const origin = activeOrigin;
    const fullscreen = nativeFullscreen;
    publishPending = false;
    const publication = { origin, fullscreen };
    activePublication = publication;
    void enqueue(origin, () => publishWithRetry(origin, fullscreen, () => stopped || activeOrigin !== origin || nativeFullscreen !== fullscreen))
      .then((legacy) => {
        if (activeOrigin === origin && legacy) unsupported = true;
      })
      .finally(() => {
        if (activePublication !== publication) return;
        activePublication = null;
        if (!stopped && activeOrigin === origin && !unsupported && (publishPending || nativeFullscreen !== fullscreen)) publishCurrent();
      });
  };

  const updateNativeFullscreen = () => {
    nativeFullscreen = window.isFullScreen();
    publishPending = true;
    publishCurrent();
  };

  const resync = () => {
    nativeFullscreen = window.isFullScreen();
    publishPending = true;
    publishCurrent();
  };

  window.on("enter-full-screen", updateNativeFullscreen);
  window.on("leave-full-screen", updateNativeFullscreen);
  webContents.on("did-finish-load", resync);

  return {
    activate(origin: string): void {
      const nextOrigin = normalizeConsoleOrigin(origin);
      if (activeOrigin !== nextOrigin) abortRequestsExcept(nextOrigin);
      activeOrigin = nextOrigin;
      unsupported = false;
      resync();
    },
    reset(origin: string): void {
      const target = normalizeConsoleOrigin(origin);
      void enqueue(target, () => publishWithRetry(target, false, () => stopped));
    },
    resync,
    stop(): void {
      if (stopped) return;
      stopped = true;
      activeOrigin = null;
      abortAllRequests();
      window.removeListener("enter-full-screen", updateNativeFullscreen);
      window.removeListener("leave-full-screen", updateNativeFullscreen);
      webContents.removeListener("did-finish-load", resync);
    },
  };
}

function normalizeConsoleOrigin(origin: string): string {
  return normalizeAnyConsoleOrigin(origin, "desktop_fullscreen_origin_invalid");
}
