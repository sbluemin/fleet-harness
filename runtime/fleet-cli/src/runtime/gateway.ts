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
	readonly abort: AbortController;
	readonly seenCallIds: Set<string>;
	readonly seenCallOrder: string[];
}

interface GatewayInvocationContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

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

	async function consumeCallsOnce(session: ActiveGatewaySession, registry: McpToolRegistry): Promise<void> {
		const response = await fetchImpl(session.registration.endpoint.replace("/mcp", "/control/calls"), {
			headers: { Authorization: `Bearer ${session.registration.controlToken}` },
			signal: session.abort.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Fleet Gateway call stream failed: ${response.status}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (!session.abort.signal.aborted) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value);
			let split = buffer.indexOf("\n\n");
			while (split >= 0) {
				const frame = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
				if (data) {
					void executeGatewayCall(JSON.parse(data) as GatewayQueuedToolCall, session, registry, fetchImpl, (err) => {
						if (!session.abort.signal.aborted) {
							connectionState = {
								state: "retrying",
								attempts: 1,
								message: `Fleet Gateway result publish failed: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					});
				}
				split = buffer.indexOf("\n\n");
			}
		}
	}

	async function consumeCallsWithReconnect(session: ActiveGatewaySession, registry: McpToolRegistry): Promise<void> {
		let attempts = 0;
		while (!session.abort.signal.aborted) {
			try {
				await consumeCallsOnce(session, registry);
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
				await refreshGatewaySession(session);
				attempts = 0;
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
			abort,
			seenCallIds: new Set(),
			seenCallOrder: [],
		};
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
		const previous = session.registration;
		session.registration = await registerWithGateway(endpoint, session.label, session.cwd, session.specs);
		void releaseGatewayRegistration(previous).catch(() => undefined);
		connectionState = {
			state: "ready",
			attempts: 0,
			message: "Fleet Gateway consumer reconnected",
		};
	}

	async function releaseGatewaySession(session: ActiveGatewaySession): Promise<void> {
		await releaseGatewayRegistration(session.registration);
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
): Promise<void> {
	if (!rememberCall(session, call.callId)) return;
	const registration = session.registration;
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
	await postJson(fetchImpl, registration.endpoint.replace("/mcp", `/control/results/${call.callId}`), registration.controlToken, {
		sessionId: call.sessionId,
		result,
	}).catch((err) => {
		onPublishFailure(err);
	});
}

function rememberCall(session: ActiveGatewaySession, callId: string): boolean {
	if (session.seenCallIds.has(callId)) return false;
	session.seenCallIds.add(callId);
	session.seenCallOrder.push(callId);
	while (session.seenCallOrder.length > 512) {
		const stale = session.seenCallOrder.shift();
		if (stale) session.seenCallIds.delete(stale);
	}
	return true;
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
