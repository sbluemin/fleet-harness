import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceAuthorization, DevicePollResult } from "./device-code.js";

export type LoginState = "pending" | "signed_in" | "denied" | "expired" | "entitlement_required" | "failed" | "cancelled";
export interface LoginStatus {
  readonly state: LoginState;
  readonly actionUrl?: string;
  readonly message?: string;
}
export type LoginStart = Omit<DeviceAuthorization, "deviceCode"> & { readonly loginId: string };
interface LoginFlow {
  start(signal: AbortSignal): Promise<DeviceAuthorization>;
  pollOnce(authorization: DeviceAuthorization, signal: AbortSignal): Promise<DevicePollResult>;
  authorized(token: Extract<DevicePollResult, { state: "authorized" }>, signal: AbortSignal): Promise<LoginStatus>;
}
interface Session {
  readonly id: string;
  readonly controller: AbortController;
  readonly started: Promise<LoginStart>;
  status: LoginStatus;
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** 진행 중인 흐름은 공급자당 하나다. device code·토큰은 공개 DTO에 들어가지 않는다. */
export function createLoginSessions(deps: { readonly now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();
  let disposed = false;
  function stop(session: Session, state: "cancelled" | "expired") {
    if (session.status.state !== "pending") return;
    session.status = { state };
    session.controller.abort();
    clearTimeout(session.timer);
  }
  async function run(session: Session, authorization: DeviceAuthorization, flow: LoginFlow) {
    const signal = session.controller.signal;
    let interval = authorization.interval;
    try {
      while (!signal.aborted) {
        await delay(interval * 1000, undefined, { signal });
        if (now() >= authorization.expiresAt) { stop(session, "expired"); break; }
        const result = await flow.pollOnce(authorization, signal);
        if (signal.aborted) break;
        if (result.state === "pending") continue;
        if (result.state === "slow_down") { interval += 5; continue; }
        const status = result.state === "authorized"
          ? await flow.authorized(result, signal) : { state: result.state };
        if (!signal.aborted) session.status = status;
        break;
      }
    } catch {
      if (!signal.aborted) session.status = { state: "failed", message: "Sign-in failed. Please try again." };
    } finally { clearTimeout(session.timer); }
  }
  return {
    start(provider: string, flow: LoginFlow): Promise<LoginStart> {
      if (disposed) return Promise.reject(new Error("Sign-in service closed"));
      const previous = sessions.get(provider);
      if (previous?.status.state === "pending") return previous.started;
      const controller = new AbortController();
      const session: Session = {
        id: randomUUID(), controller, status: { state: "pending" },
        started: Promise.resolve().then(async () => {
          const authorization = await flow.start(controller.signal);
          controller.signal.throwIfAborted();
          session.expiresAt = authorization.expiresAt;
          session.timer = setTimeout(() => stop(session, "expired"), Math.max(0, authorization.expiresAt - now()));
          session.timer.unref?.();
          void run(session, authorization, flow);
          return {
            loginId: session.id, userCode: authorization.userCode, verificationUri: authorization.verificationUri,
            ...(authorization.verificationUriComplete ? { verificationUriComplete: authorization.verificationUriComplete } : {}),
            expiresAt: authorization.expiresAt, interval: authorization.interval,
          };
        }).catch(() => {
          if (!controller.signal.aborted) session.status = { state: "failed" };
          throw new Error("Unable to start sign-in. Please try again.");
        }),
      };
      sessions.set(provider, session);
      return session.started;
    },
    status(loginId: string): LoginStatus | undefined {
      const session = [...sessions.values()].find((entry) => entry.id === loginId);
      if (session?.expiresAt !== undefined && session.expiresAt <= now()) stop(session, "expired");
      return session?.status;
    },
    cancel(loginId: string): LoginStatus | undefined {
      const session = [...sessions.values()].find((entry) => entry.id === loginId);
      if (session) stop(session, "cancelled");
      return session?.status;
    },
    cancelProvider(provider: string) {
      const session = sessions.get(provider);
      if (session) stop(session, "cancelled");
    },
    dispose() {
      disposed = true;
      for (const session of sessions.values()) stop(session, "cancelled");
      sessions.clear();
    },
  };
}
