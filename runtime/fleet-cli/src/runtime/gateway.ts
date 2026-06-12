import crypto from "node:crypto";

import {
	createGatewayDaemonLifecycle,
	createGatewayLock,
	createGatewayPaths,
	type GatewayQueuedToolCall,
	type GatewayRegisterTenantResponse,
	type GatewayToolCallResult,
} from "@dotobokuri/fleet-gateway";
import type {
	AgentToolSpec,
	ExecutorMcpSession,
	McpToolRegistry,
} from "@dotobokuri/core-agent";
import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

export interface GatewayDedicatedSessionManager {
	getEndpoint(): Promise<ExecutorEndpoint>;
	issueSessionToken(request: { readonly label: string; readonly cwd: string; readonly signal?: AbortSignal }): Promise<readonly ExecutorServerToken[]>;
	createExecutorMcpSession(request: { readonly serverName: string; readonly specs: readonly AgentToolSpec[]; readonly cwd: string; readonly signal?: AbortSignal }): Promise<ExecutorMcpSession>;
	getConnectionState(): GatewayClientConnectionState;
	publishJobEvent(event: CarrierJobStreamEvent): void;
	releaseSessionToken(label: string): void;
	cleanup(): void;
}

export interface GatewayDedicatedSessionManagerDeps {
	readonly name: string;
	readonly registry: McpToolRegistry;
	readonly lifecycle?: ReturnType<typeof createGatewayDaemonLifecycle>;
	readonly fetch?: typeof fetch;
	readonly readBootstrapToken?: () => Promise<string>;
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface GatewayClientConnectionState {
	readonly state: "ready" | "retrying" | "degraded";
	readonly attempts: number;
	readonly message: string;
}

interface ActiveGatewaySession {
	readonly label: string;
	readonly cwd: string;
	readonly specs: readonly AgentToolSpec[];
	registration: GatewayRegisterTenantResponse;
	invocation: GatewayInvocationContext;
	readonly registrationLeases: Map<string, GatewayRegistrationLease>;
	readonly abort: AbortController;
	readonly callStates: Map<string, GatewayCallState>;
	readonly seenCallOrder: string[];
}

interface GatewayInvocationContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
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

interface ExecutorEndpoint {
	readonly servers: readonly { readonly name: string; readonly url: string }[];
}

interface ExecutorServerToken {
	readonly name: string;
	readonly token: string;
}

export function createGatewayDedicatedSessionManager(deps: GatewayDedicatedSessionManagerDeps): GatewayDedicatedSessionManager {
	const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
	const fetchImpl = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const activeSessions = new Map<string, ActiveGatewaySession>();
	let primarySessionLabel: string | null = null;
	let endpointPromise: Promise<ExecutorEndpoint> | undefined;
	let connectionState: GatewayClientConnectionState = {
		state: "ready",
		attempts: 0,
		message: "Fleet Gateway consumer ready",
	};

	async function getGatewayEndpoint(): Promise<string> {
		const endpoint = await lifecycle.ensureDaemon();
		return endpoint;
	}

	async function getBootstrapToken(): Promise<string> {
		if (deps.readBootstrapToken) return deps.readBootstrapToken();
		await getGatewayEndpoint();
		const paths = createGatewayPaths();
		const lock = createGatewayLock().readLock(paths.lockFile);
		if (!lock) throw new Error("Fleet Gateway lock is missing after daemon ensure");
		return lock.token;
	}

	async function consumeCallsOnce(session: ActiveGatewaySession, registry: McpToolRegistry, onConnected?: () => void): Promise<void> {
		const response = await fetchImpl(session.registration.endpoint.replace("/mcp", "/control/calls"), {
			headers: { Authorization: `Bearer ${session.registration.controlToken}` },
			signal: session.abort.signal,
		});
		if (!response.ok || !response.body) {
			throw createGatewayCallStreamHttpError(response.status);
		}
		onConnected?.();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (!session.abort.signal.aborted) {
			const chunk = await reader.read();
			if (chunk.done) break;
			// 멀티바이트 UTF-8 문자가 청크 경계에 걸려도 깨지지 않도록 디코더 상태를 청크 간 유지한다
			buffer += decoder.decode(chunk.value, { stream: true });
			let split = buffer.indexOf("\n\n");
			while (split >= 0) {
				const frame = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
				if (data) {
					void executeGatewayCall(
						JSON.parse(data) as GatewayQueuedToolCall,
						session,
						registry,
						fetchImpl,
						(err) => {
							if (!session.abort.signal.aborted) {
								connectionState = {
									state: "retrying",
									attempts: 1,
									message: `Fleet Gateway result publish failed: ${err instanceof Error ? err.message : String(err)}`,
								};
							}
						},
						(lease) => {
							void releaseGatewayRegistrationLease(session, lease, releaseGatewayRegistration).catch(() => undefined);
						},
					);
				}
				split = buffer.indexOf("\n\n");
			}
		}
		// 스트림 종료 시 디코더에 남은 부분 바이트를 비운다 (불완전 프레임은 기존대로 폐기)
		buffer += decoder.decode();
	}

	async function consumeCallsWithReconnect(session: ActiveGatewaySession, registry: McpToolRegistry): Promise<void> {
		let attempts = 0;
		while (!session.abort.signal.aborted) {
			try {
				// 재구독이 성공하면 누적 실패 카운터를 리셋해 transient 끊김이 수명 내내 쌓여 degraded로 영구 정지하는 것을 막는다
				await consumeCallsOnce(session, registry, () => {
					if (attempts === 0) return;
					attempts = 0;
					connectionState = {
						state: "ready",
						attempts: 0,
						message: "Fleet Gateway consumer reconnected",
					};
				});
				if (session.abort.signal.aborted) return;
				throw new Error("Fleet Gateway call stream ended");
			} catch (err) {
				if (session.abort.signal.aborted) return;
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
					await refreshGatewaySession(session);
					attempts = 0;
				}
			}
		}
	}

	return {
		async getEndpoint() {
			endpointPromise ??= getGatewayEndpoint().then((endpoint) => ({ servers: [{ name: deps.name, url: endpoint }] }));
			return endpointPromise;
		},
		async issueSessionToken(request) {
			this.releaseSessionToken(request.label);
			const session = await registerGatewaySession({
				label: request.label,
				cwd: request.cwd,
				signal: request.signal,
				specs: deps.registry.getAllAgentTools(),
			});
			return [{ name: deps.name, token: session.registration.sessionToken }];
		},
		async createExecutorMcpSession(request) {
			const label = `executor:${request.serverName}:${crypto.randomUUID()}`;
			const session = await registerGatewaySession({
				label,
				cwd: request.cwd,
				signal: request.signal,
				specs: request.specs,
				bindSignalToSession: false,
			});
			return {
				serverName: request.serverName,
				token: session.registration.sessionToken,
				mcpServer: {
					type: "http",
					name: request.serverName,
					url: session.registration.endpoint,
					headers: [{ name: "Authorization", value: `Bearer ${session.registration.sessionToken}` }],
					toolTimeout: 1800,
				},
				cleanup: () => this.releaseSessionToken(label),
				detachForReuse: () => {
					session.invocation = { cwd: session.cwd };
				},
				installForReuse: (ctx) => {
					session.invocation = { cwd: ctx.cwd, signal: ctx.signal };
				},
			};
		},
		getConnectionState() {
			return connectionState;
		},
		publishJobEvent(event) {
			const session = getPrimarySession();
			if (!session) return;
			void postJson(fetchImpl, session.registration.endpoint.replace("/mcp", "/control/events"), session.registration.controlToken, {
				event,
			}).catch((err) => {
				if (!session.abort.signal.aborted) {
					connectionState = {
						state: "retrying",
						attempts: 1,
						message: `Fleet Gateway observability publish failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			});
		},
		releaseSessionToken(label) {
			const session = activeSessions.get(label.trim());
			if (!session) return;
			session.abort.abort();
			activeSessions.delete(label.trim());
			if (primarySessionLabel === label.trim()) primarySessionLabel = activeSessions.keys().next().value ?? null;
			void releaseGatewaySession(session).catch(() => undefined);
		},
		cleanup() {
			for (const label of Array.from(activeSessions.keys())) {
				this.releaseSessionToken(label);
			}
		},
	};

	async function registerGatewaySession(request: {
		readonly label: string;
		readonly cwd: string;
		readonly signal?: AbortSignal;
		readonly specs: readonly AgentToolSpec[];
		readonly bindSignalToSession?: boolean;
	}): Promise<ActiveGatewaySession> {
		const label = request.label.trim();
		if (!label) throw new Error("Gateway session label is required");
		const cwd = request.cwd.trim();
		if (!cwd) throw new Error("Gateway session cwd is required");
		const endpoint = await getGatewayEndpoint();
		const registration = await registerWithGateway(endpoint, label, cwd, request.specs);
		const abort = new AbortController();
		const session: ActiveGatewaySession = {
			label,
			cwd,
			specs: request.specs,
			registration,
			invocation: { cwd, signal: request.signal },
				registrationLeases: new Map(),
				abort,
				callStates: new Map(),
				seenCallOrder: [],
			};
		trackGatewayRegistration(session, registration);
		activeSessions.set(label, session);
		primarySessionLabel ??= label;
		connectionState = {
			state: "ready",
			attempts: 0,
			message: "Fleet Gateway consumer connected",
		};
		void consumeCallsWithReconnect(session, deps.registry).catch((err) => {
			if (!abort.signal.aborted) {
				connectionState = {
					state: "degraded",
					attempts: 5,
					message: `Fleet Gateway consumer stopped: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		});
		if (request.bindSignalToSession !== false) {
			request.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		}
		return session;
	}

	function getPrimarySession(): ActiveGatewaySession | null {
		if (primarySessionLabel) {
			const primary = activeSessions.get(primarySessionLabel);
			if (primary && !primary.abort.signal.aborted) return primary;
		}
		for (const [label, session] of activeSessions) {
			if (!session.abort.signal.aborted) {
				primarySessionLabel = label;
				return session;
			}
		}
		primarySessionLabel = null;
		return null;
	}

	async function registerWithGateway(endpoint: string, label: string, cwd: string, specs: readonly AgentToolSpec[]): Promise<GatewayRegisterTenantResponse> {
		const bootstrapToken = await getBootstrapToken();
		return postJson<GatewayRegisterTenantResponse>(fetchImpl, endpoint.replace("/mcp", "/admin/register"), bootstrapToken, {
			tenantLabel: label,
			cwd,
			tools: specs.map(specToGatewayTool),
		});
	}

	async function refreshGatewaySession(session: ActiveGatewaySession): Promise<void> {
		const endpoint = await getGatewayEndpoint();
		const previous = trackGatewayRegistration(session, session.registration);
		session.registration = await registerWithGateway(endpoint, session.label, session.cwd, session.specs);
		trackGatewayRegistration(session, session.registration);
		void releaseGatewayRegistrationLease(session, previous, releaseGatewayRegistration).catch(() => undefined);
		connectionState = {
			state: "ready",
			attempts: 0,
			message: "Fleet Gateway consumer reconnected",
		};
	}

	async function releaseGatewaySession(session: ActiveGatewaySession): Promise<void> {
		await Promise.all(Array.from(session.registrationLeases.values()).map((lease) => releaseGatewayRegistrationLease(session, lease, releaseGatewayRegistration, true)));
	}

	async function releaseGatewayRegistration(registration: GatewayRegisterTenantResponse): Promise<void> {
		await postJson(fetchImpl, registration.endpoint.replace("/mcp", "/control/release"), registration.controlToken, {});
	}
}

async function executeGatewayCall(
	call: GatewayQueuedToolCall,
	session: ActiveGatewaySession,
	registry: McpToolRegistry,
	fetchImpl: typeof fetch,
	onPublishFailure: (err: unknown) => void,
	onRegistrationIdle: (lease: GatewayRegistrationLease) => void,
): Promise<void> {
	const action = prepareGatewayCall(session, call.callId);
	if (action.kind === "ignore") return;
	if (action.kind === "retry") {
		await publishGatewayCallResult(call, session, action.result, fetchImpl, onPublishFailure, onRegistrationIdle);
		return;
	}
	const lease = acquireGatewayRegistration(session);
	const registration = lease.registration;
	const invocation = session.invocation;
	const signal = combineAbortSignals([session.abort.signal, invocation.signal].filter((candidate): candidate is AbortSignal => Boolean(candidate)));
	const result = await registry.invoke(call.toolName, call.args, {
		cwd: invocation.cwd,
		toolCallId: call.callId,
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
		markGatewayCallPublished(session, call.callId);
	} catch (err) {
		markGatewayCallPublishFailed(session, call.callId, result);
		onPublishFailure(err);
	} finally {
		finishGatewayRegistration(session, lease, onRegistrationIdle);
	}
}

async function publishGatewayCallResult(
	call: GatewayQueuedToolCall,
	session: ActiveGatewaySession,
	result: GatewayToolCallResult,
	fetchImpl: typeof fetch,
	onPublishFailure: (err: unknown) => void,
	onRegistrationIdle: (lease: GatewayRegistrationLease) => void,
): Promise<void> {
	const lease = acquireGatewayRegistration(session);
	const registration = lease.registration;
	try {
		await postJson(fetchImpl, registration.endpoint.replace("/mcp", `/control/results/${call.callId}`), registration.controlToken, {
			sessionId: call.sessionId,
			result,
		});
		markGatewayCallPublished(session, call.callId);
	} catch (err) {
		markGatewayCallPublishFailed(session, call.callId, result);
		onPublishFailure(err);
	} finally {
		finishGatewayRegistration(session, lease, onRegistrationIdle);
	}
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

function specToGatewayTool(spec: AgentToolSpec) {
	return {
		name: spec.id,
		description: spec.description,
		inputSchema: spec.parameters,
	};
}
