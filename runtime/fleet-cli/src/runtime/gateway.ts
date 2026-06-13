import crypto from "node:crypto";

import type {
	AgentToolSpec,
	ExecutorMcpSession,
	McpToolRegistry,
} from "@dotobokuri/core-agent";
import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";
import {
	createGatewayConsumerClient,
	createGatewayDaemonLifecycle,
	type GatewayConsumerClient,
	type GatewayConsumerClientConnectionState,
	type GatewayQueuedToolCall,
	type GatewayToolCallResult,
	type GatewayToolSnapshot,
} from "@dotobokuri/fleet-gateway";

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
	client: GatewayConsumerClient;
	invocation: GatewayInvocationContext | null;
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
	const activeSessions = new Map<string, ActiveGatewaySession>();
	let primarySessionLabel: string | null = null;
	let endpointPromise: Promise<ExecutorEndpoint> | undefined;
	let lastConnectionState: GatewayConsumerClientConnectionState = {
		state: "ready",
		attempts: 0,
		message: "Fleet Gateway consumer ready",
	};

	function createSessionClient(request: {
		readonly label: string;
		readonly cwd: string;
		readonly specs: readonly AgentToolSpec[];
		readonly signal?: AbortSignal;
		readonly bindSignalToSession?: boolean;
	}): ActiveGatewaySession {
		const label = request.label.trim();
		if (!label) throw new Error("Gateway session label is required");
		const cwd = request.cwd.trim();
		if (!cwd) throw new Error("Gateway session cwd is required");
		const session: ActiveGatewaySession = {
			label,
			client: undefined as unknown as GatewayConsumerClient,
			invocation: { cwd, signal: request.signal },
		};
		const abort = new AbortController();
		if (request.bindSignalToSession !== false) {
			request.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		}
		const client = createGatewayConsumerClient({
			name: label,
			cwd,
			lifecycle,
			fetch: deps.fetch,
			readBootstrapToken: deps.readBootstrapToken,
			sleep: deps.sleep,
			signal: abort.signal,
			executionPort: {
				listTools: () => request.specs.map(specToGatewayTool),
				execute: (call, ctx) => executeGatewayCall(call, session, ctx.signal),
			},
		});
		session.client = client;
		return session;
	}

	return {
		async getEndpoint() {
			endpointPromise ??= lifecycle.ensureDaemon().then((endpoint) => ({ servers: [{ name: deps.name, url: endpoint }] }));
			return endpointPromise;
		},
		async issueSessionToken(request) {
			this.releaseSessionToken(request.label);
			const session = createSessionClient({
				label: request.label,
				cwd: request.cwd,
				signal: request.signal,
				specs: deps.registry.getAllAgentTools(),
			});
			const registration = await session.client.connect();
			activeSessions.set(session.label, session);
			primarySessionLabel ??= session.label;
			return [{ name: deps.name, token: registration.sessionToken }];
		},
		async createExecutorMcpSession(request) {
			const label = `executor:${request.serverName}:${crypto.randomUUID()}`;
			const session = createSessionClient({
				label,
				cwd: request.cwd,
				signal: request.signal,
				specs: request.specs,
				bindSignalToSession: false,
			});
			const registration = await session.client.connect();
			activeSessions.set(session.label, session);
			primarySessionLabel ??= session.label;
			return {
				serverName: request.serverName,
				token: registration.sessionToken,
				mcpServer: {
					type: "http",
					name: request.serverName,
					url: registration.endpoint,
					headers: [{ name: "Authorization", value: `Bearer ${registration.sessionToken}` }],
					toolTimeout: 1800,
				},
				cleanup: () => this.releaseSessionToken(label),
				detachForReuse: () => {
					session.invocation = null;
				},
				installForReuse: (ctx) => {
					session.invocation = { cwd: ctx.cwd, signal: ctx.signal };
				},
			};
		},
		getConnectionState() {
			const currentState = getPrimarySession()?.client.getConnectionState();
			if (currentState) lastConnectionState = currentState;
			return lastConnectionState;
		},
		publishJobEvent(event) {
			getPrimarySession()?.client.publishEvent(event);
		},
		releaseSessionToken(label) {
			const key = label.trim();
			const session = activeSessions.get(key);
			if (!session) return;
			lastConnectionState = session.client.getConnectionState();
			session.client.release();
			activeSessions.delete(key);
			if (primarySessionLabel === key) primarySessionLabel = activeSessions.keys().next().value ?? null;
		},
		cleanup() {
			for (const label of Array.from(activeSessions.keys())) {
				this.releaseSessionToken(label);
			}
		},
	};

	async function executeGatewayCall(call: GatewayQueuedToolCall, session: ActiveGatewaySession, signal: AbortSignal): Promise<GatewayToolCallResult> {
		const invocation = session.invocation;
		if (!invocation) {
			return {
				content: [{ type: "text", text: "Fleet Gateway session is detached between prompts" }],
				isError: true,
			};
		}
		return deps.registry.invoke(call.toolName, call.args, {
			cwd: invocation.cwd,
			toolCallId: call.callId,
			signal: combineAbortSignals([signal, invocation.signal].filter((candidate): candidate is AbortSignal => Boolean(candidate))),
		}).catch((err): GatewayToolCallResult => ({
			content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
			isError: true,
		}));
	}

	function getPrimarySession(): ActiveGatewaySession | null {
		if (primarySessionLabel) {
			const primary = activeSessions.get(primarySessionLabel);
			if (primary) return primary;
		}
		const next = activeSessions.entries().next().value as [string, ActiveGatewaySession] | undefined;
		primarySessionLabel = next?.[0] ?? null;
		return next?.[1] ?? null;
	}
}

function specToGatewayTool(spec: AgentToolSpec): GatewayToolSnapshot {
	return {
		name: spec.id,
		description: spec.description,
		inputSchema: spec.parameters,
	};
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
