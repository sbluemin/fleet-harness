import type {
  GatewayConsumerClient,
  GatewayConsumerClientConnectionState,
  GatewayConsumerClientDeps,
  GatewayQueuedToolCall,
  GatewayRegisterTenantResponse,
  GatewayToolCallResult,
} from "./api-types.js";
import { createGatewayDaemonLifecycle } from "./cli.js";
import { createGatewayLock } from "./lock.js";
import { createGatewayPaths } from "./paths.js";

interface ActiveGatewaySession {
  readonly label: string;
  readonly cwd: string;
  registration: GatewayRegisterTenantResponse;
  readonly registrationLeases: Map<string, GatewayRegistrationLease>;
  readonly abort: AbortController;
  readonly callStates: Map<string, GatewayCallState>;
  readonly seenCallOrder: string[];
}

interface GatewayRegistrationLease {
  readonly registration: GatewayRegisterTenantResponse;
  inFlight: number;
  releaseRequested: boolean;
  released: boolean;
}

interface GatewayCallStreamHttpError extends Error {
  readonly gatewayStatus: number;
}

type GatewayCallState =
  | { readonly status: "running" }
  | { readonly status: "published" }
  | { readonly status: "publish_failed"; readonly result: GatewayToolCallResult };

type GatewayCallAction =
  | { readonly kind: "run" }
  | { readonly kind: "retry"; readonly result: GatewayToolCallResult }
  | { readonly kind: "ignore" };

export function createGatewayConsumerClient(deps: GatewayConsumerClientDeps): GatewayConsumerClient {
  const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let session: ActiveGatewaySession | null = null;
  let endpointPromise: Promise<string> | undefined;
  let connectionState: GatewayConsumerClientConnectionState = {
    state: "ready",
    attempts: 0,
    message: "Fleet Gateway consumer ready",
  };

  async function getGatewayEndpoint(): Promise<string> {
    endpointPromise ??= lifecycle.ensureDaemon();
    return endpointPromise;
  }

  async function getBootstrapToken(): Promise<string> {
    if (deps.readBootstrapToken) return deps.readBootstrapToken();
    await getGatewayEndpoint();
    const paths = createGatewayPaths();
    const lock = createGatewayLock().readLock(paths.lockFile);
    if (!lock) throw new Error("Fleet Gateway lock is missing after daemon ensure");
    return lock.token;
  }

  async function registerWithGateway(): Promise<GatewayRegisterTenantResponse> {
    const endpoint = await getGatewayEndpoint();
    const bootstrapToken = await getBootstrapToken();
    return postJson<GatewayRegisterTenantResponse>(fetchImpl, endpoint.replace("/mcp", "/admin/register"), bootstrapToken, {
      tenantLabel: deps.name,
      cwd: deps.cwd,
      tools: deps.executionPort.listTools(),
    });
  }

  async function connect(): Promise<GatewayRegisterTenantResponse> {
    release();
    const registration = await registerWithGateway();
    const abort = new AbortController();
    const nextSession: ActiveGatewaySession = {
      label: deps.name,
      cwd: deps.cwd,
      registration,
      registrationLeases: new Map(),
      abort,
      callStates: new Map(),
      seenCallOrder: [],
    };
    trackGatewayRegistration(nextSession, registration);
    session = nextSession;
    connectionState = {
      state: "ready",
      attempts: 0,
      message: "Fleet Gateway consumer connected",
    };
    deps.signal?.addEventListener("abort", () => release(), { once: true });
    void consumeCallsWithReconnect(nextSession).catch((err) => {
      if (!nextSession.abort.signal.aborted) {
        connectionState = {
          state: "degraded",
          attempts: 5,
          message: `Fleet Gateway consumer stopped: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
    return registration;
  }

  async function consumeCallsOnce(activeSession: ActiveGatewaySession, onConnected?: () => void): Promise<void> {
    const response = await fetchImpl(activeSession.registration.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${activeSession.registration.controlToken}` },
      signal: activeSession.abort.signal,
    });
    if (!response.ok || !response.body) {
      throw createGatewayCallStreamHttpError(response.status);
    }
    onConnected?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!activeSession.abort.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) {
          void executeGatewayCall(JSON.parse(data) as GatewayQueuedToolCall, activeSession, (err) => {
            if (!activeSession.abort.signal.aborted) {
              connectionState = {
                state: "retrying",
                attempts: 1,
                message: `Fleet Gateway result publish failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }, (lease) => {
            void releaseGatewayRegistrationLease(activeSession, lease, releaseGatewayRegistration).catch(() => undefined);
          });
        }
        split = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
  }

  async function consumeCallsWithReconnect(activeSession: ActiveGatewaySession): Promise<void> {
    let attempts = 0;
    while (!activeSession.abort.signal.aborted) {
      try {
        await consumeCallsOnce(activeSession, () => {
          if (attempts === 0) return;
          attempts = 0;
          connectionState = {
            state: "ready",
            attempts: 0,
            message: "Fleet Gateway consumer reconnected",
          };
        });
        if (activeSession.abort.signal.aborted) return;
        throw new Error("Fleet Gateway call stream ended");
      } catch (err) {
        if (activeSession.abort.signal.aborted) return;
        attempts += 1;
        endpointPromise = undefined;
        connectionState = {
          state: attempts >= 5 ? "degraded" : "retrying",
          attempts,
          message: `Fleet Gateway consumer reconnecting: ${err instanceof Error ? err.message : String(err)}`,
        };
        if (attempts >= 5) return;
        await sleep(Math.min(1_000, attempts * 100));
        if (isGatewayCallStreamAuthError(err)) {
          await refreshGatewaySession(activeSession);
          attempts = 0;
        }
      }
    }
  }

  async function refreshGatewaySession(activeSession: ActiveGatewaySession): Promise<void> {
    const previous = trackGatewayRegistration(activeSession, activeSession.registration);
    activeSession.registration = await registerWithGateway();
    trackGatewayRegistration(activeSession, activeSession.registration);
    void releaseGatewayRegistrationLease(activeSession, previous, releaseGatewayRegistration).catch(() => undefined);
    connectionState = {
      state: "ready",
      attempts: 0,
      message: "Fleet Gateway consumer reconnected",
    };
  }

  async function executeGatewayCall(
    call: GatewayQueuedToolCall,
    activeSession: ActiveGatewaySession,
    onPublishFailure: (err: unknown) => void,
    onRegistrationIdle: (lease: GatewayRegistrationLease) => void,
  ): Promise<void> {
    const action = prepareGatewayCall(activeSession, call.callId);
    if (action.kind === "ignore") return;
    if (action.kind === "retry") {
      await publishGatewayCallResult(call, activeSession, action.result, onPublishFailure, onRegistrationIdle);
      return;
    }
    const lease = acquireGatewayRegistration(activeSession);
    const registration = lease.registration;
    const signal = combineAbortSignals([activeSession.abort.signal, deps.signal].filter((candidate): candidate is AbortSignal => Boolean(candidate)));
    const result = await deps.executionPort.execute(call, {
      cwd: activeSession.cwd,
      signal,
    }).catch((err): GatewayToolCallResult => ({
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    }));
    try {
      await postJson(fetchImpl, registration.endpoint.replace("/mcp", `/control/results/${call.callId}`), registration.controlToken, {
        sessionId: call.sessionId,
        result,
      });
      markGatewayCallPublished(activeSession, call.callId);
    } catch (err) {
      markGatewayCallPublishFailed(activeSession, call.callId, result);
      onPublishFailure(err);
    } finally {
      finishGatewayRegistration(activeSession, lease, onRegistrationIdle);
    }
  }

  async function publishGatewayCallResult(
    call: GatewayQueuedToolCall,
    activeSession: ActiveGatewaySession,
    result: GatewayToolCallResult,
    onPublishFailure: (err: unknown) => void,
    onRegistrationIdle: (lease: GatewayRegistrationLease) => void,
  ): Promise<void> {
    const lease = acquireGatewayRegistration(activeSession);
    const registration = lease.registration;
    try {
      await postJson(fetchImpl, registration.endpoint.replace("/mcp", `/control/results/${call.callId}`), registration.controlToken, {
        sessionId: call.sessionId,
        result,
      });
      markGatewayCallPublished(activeSession, call.callId);
    } catch (err) {
      markGatewayCallPublishFailed(activeSession, call.callId, result);
      onPublishFailure(err);
    } finally {
      finishGatewayRegistration(activeSession, lease, onRegistrationIdle);
    }
  }

  async function releaseGatewayRegistration(registration: GatewayRegisterTenantResponse): Promise<void> {
    await postJson(fetchImpl, registration.endpoint.replace("/mcp", "/control/release"), registration.controlToken, {});
  }

  async function releaseGatewaySession(activeSession: ActiveGatewaySession): Promise<void> {
    await Promise.all(Array.from(activeSession.registrationLeases.values()).map((lease) => releaseGatewayRegistrationLease(activeSession, lease, releaseGatewayRegistration, true)));
  }

  function publishEvent(event: unknown): void {
    const activeSession = session;
    if (!activeSession || activeSession.abort.signal.aborted) return;
    void postJson(fetchImpl, activeSession.registration.endpoint.replace("/mcp", "/control/events"), activeSession.registration.controlToken, {
      event,
    }).catch((err) => {
      if (!activeSession.abort.signal.aborted) {
        connectionState = {
          state: "retrying",
          attempts: 1,
          message: `Fleet Gateway observability publish failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
  }

  function release(): void {
    const activeSession = session;
    if (!activeSession) return;
    activeSession.abort.abort();
    session = null;
    void releaseGatewaySession(activeSession).catch(() => undefined);
  }

  return {
    connect,
    getEndpoint: getGatewayEndpoint,
    getRegistration: () => session?.registration ?? null,
    getConnectionState: () => connectionState,
    publishEvent,
    release,
  };
}

function prepareGatewayCall(session: ActiveGatewaySession, callId: string): GatewayCallAction {
  const existing = session.callStates.get(callId);
  if (existing?.status === "publish_failed") return { kind: "retry", result: existing.result };
  if (existing) return { kind: "ignore" };
  session.callStates.set(callId, { status: "running" });
  session.seenCallOrder.push(callId);
  while (session.seenCallOrder.length > 512) {
    const stale = session.seenCallOrder.shift();
    if (stale) session.callStates.delete(stale);
  }
  return { kind: "run" };
}

function markGatewayCallPublished(session: ActiveGatewaySession, callId: string): void {
  if (session.callStates.has(callId)) {
    session.callStates.set(callId, { status: "published" });
  }
}

function markGatewayCallPublishFailed(session: ActiveGatewaySession, callId: string, result: GatewayToolCallResult): void {
  if (session.callStates.has(callId)) {
    session.callStates.set(callId, { status: "publish_failed", result });
  }
}

function trackGatewayRegistration(session: ActiveGatewaySession, registration: GatewayRegisterTenantResponse): GatewayRegistrationLease {
  const key = gatewayRegistrationKey(registration);
  const existing = session.registrationLeases.get(key);
  if (existing) return existing;
  const lease: GatewayRegistrationLease = {
    registration,
    inFlight: 0,
    releaseRequested: false,
    released: false,
  };
  session.registrationLeases.set(key, lease);
  return lease;
}

function acquireGatewayRegistration(session: ActiveGatewaySession): GatewayRegistrationLease {
  const lease = trackGatewayRegistration(session, session.registration);
  lease.inFlight += 1;
  return lease;
}

function finishGatewayRegistration(session: ActiveGatewaySession, lease: GatewayRegistrationLease, onRegistrationIdle: (lease: GatewayRegistrationLease) => void): void {
  lease.inFlight = Math.max(0, lease.inFlight - 1);
  if (lease.inFlight === 0 && lease.releaseRequested && !lease.released) {
    onRegistrationIdle(lease);
  }
}

async function releaseGatewayRegistrationLease(
  session: ActiveGatewaySession,
  lease: GatewayRegistrationLease,
  releaseRegistration: (registration: GatewayRegisterTenantResponse) => Promise<void>,
  force = false,
): Promise<void> {
  if (lease.released) return;
  if (!force && lease.inFlight > 0) {
    lease.releaseRequested = true;
    return;
  }
  lease.released = true;
  lease.releaseRequested = false;
  session.registrationLeases.delete(gatewayRegistrationKey(lease.registration));
  await releaseRegistration(lease.registration);
}

function gatewayRegistrationKey(registration: GatewayRegisterTenantResponse): string {
  return registration.controlToken;
}

function createGatewayCallStreamHttpError(status: number): GatewayCallStreamHttpError {
  return Object.assign(new Error(`Fleet Gateway call stream failed: ${status}`), { gatewayStatus: status });
}

function isGatewayCallStreamAuthError(err: unknown): boolean {
  if (!(err instanceof Error) || !("gatewayStatus" in err)) return false;
  const status = (err as GatewayCallStreamHttpError).gatewayStatus;
  return status === 401 || status === 403;
}

function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([...signals]);
  }
  const abortedSignal = signals.find((signal) => signal.aborted);
  if (abortedSignal) {
    return AbortSignal.abort(abortedSignal.reason);
  }
  const controller = new AbortController();
  const cleanup = new Map<AbortSignal, () => void>();
  const abortFrom = (signal: AbortSignal) => {
    for (const [registeredSignal, listener] of cleanup) {
      registeredSignal.removeEventListener("abort", listener);
    }
    cleanup.clear();
    controller.abort(signal.reason);
  };
  for (const signal of signals) {
    const listener = () => {
      abortFrom(signal);
    };
    cleanup.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, token: string, body: unknown): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Fleet Gateway request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
