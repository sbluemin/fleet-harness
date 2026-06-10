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
	ExecutorEndpoint,
	ExecutorServerToken,
	McpToolRegistry,
} from "@dotobokuri/core-mcp-server";
import type { ExecutorMcpSession } from "@dotobokuri/core-agent";
import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

export interface GatewayDedicatedSessionManager {
	getEndpoint(): Promise<ExecutorEndpoint>;
	issueSessionToken(request: { readonly label: string; readonly cwd: string; readonly signal?: AbortSignal }): Promise<readonly ExecutorServerToken[]>;
	createExecutorMcpSession(request: { readonly serverName: string; readonly specs: readonly AgentToolSpec[]; readonly cwd: string; readonly signal?: AbortSignal }): Promise<ExecutorMcpSession>;
	publishJobEvent(event: CarrierJobStreamEvent): void;
	releaseSessionToken(label: string): void;
	cleanup(): void;
}

export interface GatewayDedicatedSessionManagerDeps {
	readonly name: string;
	readonly registry: McpToolRegistry;
	readonly lifecycle?: ReturnType<typeof createGatewayDaemonLifecycle>;
	readonly fetch?: typeof fetch;
}

interface ActiveGatewaySession {
	readonly label: string;
	readonly cwd: string;
	readonly registration: GatewayRegisterTenantResponse;
	readonly abort: AbortController;
}

export function createGatewayDedicatedSessionManager(deps: GatewayDedicatedSessionManagerDeps): GatewayDedicatedSessionManager {
	const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
	const fetchImpl = deps.fetch ?? fetch;
	const activeSessions = new Map<string, ActiveGatewaySession>();
	let endpointPromise: Promise<ExecutorEndpoint> | undefined;

	async function getGatewayEndpoint(): Promise<string> {
		const endpoint = await lifecycle.ensureDaemon();
		return endpoint;
	}

	async function getBootstrapToken(): Promise<string> {
		await getGatewayEndpoint();
		const paths = createGatewayPaths();
		const lock = createGatewayLock().readLock(paths.lockFile);
		if (!lock) throw new Error("Fleet Gateway lock is missing after daemon ensure");
		return lock.token;
	}

	async function consumeCalls(session: ActiveGatewaySession, registry: McpToolRegistry): Promise<void> {
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
					void executeGatewayCall(JSON.parse(data) as GatewayQueuedToolCall, session, registry, fetchImpl);
				}
				split = buffer.indexOf("\n\n");
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
				detachForReuse: () => undefined,
				installForReuse: () => undefined,
			};
		},
		publishJobEvent(event) {
			for (const session of activeSessions.values()) {
				void postJson(fetchImpl, session.registration.endpoint.replace("/mcp", "/control/events"), session.registration.controlToken, {
					event,
				}).catch((err) => {
					if (!session.abort.signal.aborted) {
						console.error("[fleet-cli] Fleet Gateway observability publish failed", err);
					}
				});
			}
		},
		releaseSessionToken(label) {
			const session = activeSessions.get(label.trim());
			if (!session) return;
			session.abort.abort();
			activeSessions.delete(label.trim());
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
	}): Promise<ActiveGatewaySession> {
		const label = request.label.trim();
		if (!label) throw new Error("Gateway session label is required");
		const cwd = request.cwd.trim();
		if (!cwd) throw new Error("Gateway session cwd is required");
		const endpoint = await getGatewayEndpoint();
		const bootstrapToken = await getBootstrapToken();
		const registration = await postJson<GatewayRegisterTenantResponse>(fetchImpl, endpoint.replace("/mcp", "/admin/register"), bootstrapToken, {
			tenantLabel: label,
			cwd,
			tools: request.specs.map(specToGatewayTool),
		});
		const abort = new AbortController();
		const session: ActiveGatewaySession = { label, cwd, registration, abort };
		activeSessions.set(label, session);
		void consumeCalls(session, deps.registry).catch((err) => {
			if (!abort.signal.aborted) {
				console.error("[fleet-cli] Fleet Gateway call consumer stopped", err);
			}
		});
		request.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		return session;
	}
}

async function executeGatewayCall(
	call: GatewayQueuedToolCall,
	session: ActiveGatewaySession,
	registry: McpToolRegistry,
	fetchImpl: typeof fetch,
): Promise<void> {
	const result = await registry.invoke(call.toolName, call.args, {
		cwd: session.cwd,
		toolCallId: call.callId,
		signal: session.abort.signal,
	}).catch((err): GatewayToolCallResult => ({
		content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
		isError: true,
	}));
	await postJson(fetchImpl, session.registration.endpoint.replace("/mcp", `/control/results/${call.callId}`), session.registration.controlToken, {
		sessionId: call.sessionId,
		result,
	});
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
