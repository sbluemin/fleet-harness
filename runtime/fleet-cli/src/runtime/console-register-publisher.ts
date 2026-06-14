import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
	PushEventEnvelope,
	PushEventsResponse,
	RegisterCliRequest,
	RegisterCliResponse,
} from "@dotobokuri/core-agent";
import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import { readFleetCliRelease } from "../release.js";
import type { FleetCliChannel } from "../release.js";

export interface ConsoleRegisterPublisher {
	readonly cliRunId: string;
	getConnectionState(): ConsoleRegistrationState;
	publishJobEvent(event: CarrierJobStreamEvent): void;
	start(): void;
	cleanup(): Promise<void>;
}

export interface ConsoleRegisterPublisherDeps {
	readonly cwd: string;
	readonly fleetVersion: string;
	readonly mcpServerName: string;
	readonly toolCount: number;
	readonly channel?: FleetCliChannel;
	readonly cliRunId?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
	readonly fs?: Pick<typeof fs, "lstatSync" | "readFileSync" | "statSync">;
	readonly now?: () => number;
	readonly pid?: number;
	readonly setTimeout?: (callback: () => void, ms: number) => ConsolePublisherTimer;
	readonly clearTimeout?: (timer: ConsolePublisherTimer) => void;
}

export interface ConsoleRegistrationState {
	readonly state: "ready" | "retrying" | "degraded";
	readonly attempts: number;
	readonly message: string;
	readonly registrationId?: string;
	readonly endpoint?: string;
	readonly bufferedEvents: number;
	readonly droppedEvents: number;
}

interface ConsolePublisherTimer {
	unref?(): void;
}

interface ConsoleLockPayload {
	readonly endpoint?: string;
	readonly host?: string;
	readonly port?: number;
	readonly token?: string;
}

interface ConsoleEndpoint {
	readonly baseUrl: string;
	readonly bootstrapToken?: string;
}

interface ActiveRegistration {
	readonly endpoint: ConsoleEndpoint;
	readonly registrationId: string;
	readonly ingestToken: string;
	readonly heartbeatIntervalMs: number;
	readonly leaseTtlMs: number;
	readonly maxBatchEvents: number;
}

const CONSOLE_PROTOCOL_VERSION = "fleet-console-register.v1";
const DEFAULT_BUFFER_LIMIT = 256;
const DEFAULT_CONSOLE_LOCK_DIR_NAME = "fleet-console";
const DEFAULT_CONSOLE_LOCK_FILE_NAME = "console.lock";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const REGISTER_PATH = "/api/cli/register";
const EVENTS_PATH = "/api/cli/events";
const HEARTBEAT_PATH = "/api/cli/heartbeat";
const DEREGISTER_PATH = "/api/cli/deregister";
const HEALTH_PATH = "/health";

export function createConsoleRegisterPublisher(deps: ConsoleRegisterPublisherDeps): ConsoleRegisterPublisher {
	const fetchImpl = deps.fetch ?? fetch;
	const fsImpl = deps.fs ?? fs;
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	const cliRunId = deps.cliRunId ?? deps.env?.FLEET_CONSOLE_SESSION_ID ?? crypto.randomUUID();
	// 릴리스 채널은 프로세스 수명 동안 고정되므로 팩토리 진입 시 한 번만 확인한다.
	const channel = deps.channel ?? readFleetCliRelease().channel;
	const startedAt = new Date(now()).toISOString();
	const buffer: PushEventEnvelope[] = [];
	let activeRegistration: ActiveRegistration | null = null;
	let stopped = false;
	let flushInFlight = false;
	let retryTimer: ConsolePublisherTimer | null = null;
	let heartbeatTimer: ConsolePublisherTimer | null = null;
	let attempts = 0;
	let droppedEvents = 0;
	let seq = 0;
	let state: ConsoleRegistrationState = {
		state: "degraded",
		attempts,
		message: "Fleet Console is not registered",
		bufferedEvents: 0,
		droppedEvents,
	};

	return {
		cliRunId,
		getConnectionState() {
			return state;
		},
		publishJobEvent(event) {
			if (stopped) return;
			seq += 1;
			buffer.push({
				cliRunId,
				seq,
				at: new Date(now()).toISOString(),
				event,
			});
			while (buffer.length > DEFAULT_BUFFER_LIMIT) {
				buffer.shift();
				droppedEvents += 1;
			}
			updateState(activeRegistration ? "ready" : "retrying", activeRegistration ? "Fleet Console registration ready" : "Fleet Console registration pending");
			void flushOrRegister();
		},
		start() {
			if (stopped) return;
			void flushOrRegister();
		},
		async cleanup() {
			stopped = true;
			clearRetryTimer();
			clearHeartbeatTimer();
			const registration = activeRegistration;
			activeRegistration = null;
			if (!registration) return;
			await postJson(registration.endpoint, DEREGISTER_PATH, {
				cliRunId,
				registrationId: registration.registrationId,
				at: new Date(now()).toISOString(),
				reason: "shutdown",
			}, registration.ingestToken).catch(() => undefined);
		},
	};

	async function flushOrRegister(): Promise<void> {
		if (stopped || flushInFlight) return;
		flushInFlight = true;
		try {
			if (!activeRegistration) {
				activeRegistration = await registerWithConsole();
				attempts = 0;
				updateState("ready", "Fleet Console registration ready");
				scheduleHeartbeat(activeRegistration.heartbeatIntervalMs);
			}
			await flushBufferedEvents(activeRegistration);
		} catch (error) {
			activeRegistration = null;
			attempts += 1;
			updateState("retrying", `Fleet Console registration retry scheduled: ${formatError(error)}`);
			scheduleRetry();
		} finally {
			flushInFlight = false;
		}
	}

	async function registerWithConsole(): Promise<ActiveRegistration> {
		const endpoint = discoverConsoleEndpoint();
		if (!endpoint) {
			throw new Error("console endpoint unavailable");
		}
		await probeConsole(endpoint);
		const response = await postJson<RegisterCliResponse>(endpoint, REGISTER_PATH, buildRegisterRequest(), endpoint.bootstrapToken);
		assertRegisterResponse(response);
		return {
			endpoint,
			registrationId: response.registrationId,
			ingestToken: response.ingestToken,
			heartbeatIntervalMs: response.heartbeatIntervalMs,
			leaseTtlMs: response.leaseTtlMs,
			maxBatchEvents: response.maxBatchEvents,
		};
	}

	async function flushBufferedEvents(registration: ActiveRegistration): Promise<void> {
		while (!stopped && buffer.length > 0) {
			const batchSize = Math.max(1, Math.min(registration.maxBatchEvents, buffer.length));
			const batch = buffer.slice(0, batchSize);
			const ack = await postJson<PushEventsResponse>(registration.endpoint, EVENTS_PATH, batch, registration.ingestToken);
			const removeCount = computeAckRemovalCount(batch, ack);
			if (removeCount <= 0) {
				throw new Error("console event ack did not advance");
			}
			buffer.splice(0, removeCount);
			updateState("ready", "Fleet Console event batch accepted");
		}
	}

	async function probeConsole(endpoint: ConsoleEndpoint): Promise<void> {
		const response = await fetchImpl(buildUrl(endpoint.baseUrl, HEALTH_PATH), {
			headers: endpoint.bootstrapToken ? { Authorization: `Bearer ${endpoint.bootstrapToken}` } : undefined,
		});
		if (!response.ok) {
			throw new Error(`console probe failed: ${response.status}`);
		}
	}

	async function postJson<ResponseBody>(
		endpoint: ConsoleEndpoint,
		pathname: string,
		body: unknown,
		token: string | undefined,
	): Promise<ResponseBody> {
		const response = await fetchImpl(buildUrl(endpoint.baseUrl, pathname), {
			method: "POST",
			headers: token ? { ...JSON_HEADERS, Authorization: `Bearer ${token}` } : JSON_HEADERS,
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`console POST ${pathname} failed: ${response.status}`);
		}
		return response.json() as Promise<ResponseBody>;
	}

	function buildRegisterRequest(): RegisterCliRequest {
		return {
			protocolVersion: CONSOLE_PROTOCOL_VERSION,
			cliRunId,
			tenantLabel: path.basename(deps.cwd) || deps.cwd,
			cwd: deps.cwd,
			pid: deps.pid ?? process.pid,
			startedAt,
			fleetVersion: deps.fleetVersion,
			mcp: {
				protocolVersion: "2025-03-26",
				servers: [{ name: deps.mcpServerName, toolCount: deps.toolCount }],
			},
		};
	}

	function discoverConsoleEndpoint(): ConsoleEndpoint | null {
		const envEndpoint = normalizeBaseUrl(deps.env?.FLEET_CONSOLE_ENDPOINT ?? deps.env?.FLEET_CONSOLE_URL);
		if (envEndpoint) return { baseUrl: envEndpoint, bootstrapToken: deps.env?.FLEET_CONSOLE_TOKEN };
		const lock = readConsoleLock();
		if (!lock?.endpoint) return null;
		const endpoint = normalizeBaseUrl(lock.endpoint);
		return endpoint ? { baseUrl: endpoint, bootstrapToken: lock.token } : null;
	}

	function readConsoleLock(): ConsoleLockPayload | null {
		const lockFile = deps.env?.FLEET_CONSOLE_LOCK_FILE ?? path.join(defaultConsoleBaseDir(channel), DEFAULT_CONSOLE_LOCK_FILE_NAME);
		try {
			const stat = fsImpl.lstatSync(lockFile);
			if (stat.isSymbolicLink()) {
				throw new Error(`Refusing symbolic console lock: ${lockFile}`);
			}
			const dirStat = fsImpl.statSync(path.dirname(lockFile));
			const fileStat = fsImpl.statSync(lockFile);
			const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
			if (currentUid != null && (dirStat.uid !== currentUid || fileStat.uid !== currentUid)) {
				throw new Error("Console lock owner does not match current user");
			}
			return JSON.parse(fsImpl.readFileSync(lockFile, "utf8")) as ConsoleLockPayload;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	function scheduleHeartbeat(intervalMs: number): void {
		clearHeartbeatTimer();
		const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_INTERVAL_MS;
		heartbeatTimer = setTimer(() => {
			heartbeatTimer = null;
			void sendHeartbeat();
		}, delay);
		heartbeatTimer.unref?.();
	}

	async function sendHeartbeat(): Promise<void> {
		const registration = activeRegistration;
		if (stopped || !registration) return;
		try {
			await postJson(registration.endpoint, HEARTBEAT_PATH, {
				cliRunId,
				registrationId: registration.registrationId,
				at: new Date(now()).toISOString(),
			}, registration.ingestToken);
			scheduleHeartbeat(registration.heartbeatIntervalMs);
		} catch (error) {
			activeRegistration = null;
			attempts += 1;
			updateState("retrying", `Fleet Console heartbeat failed: ${formatError(error)}`);
			scheduleRetry();
		}
	}

	function scheduleRetry(): void {
		if (stopped || retryTimer) return;
		const delay = Math.min(DEFAULT_RETRY_MAX_MS, DEFAULT_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)));
		retryTimer = setTimer(() => {
			retryTimer = null;
			void flushOrRegister();
		}, delay);
		retryTimer.unref?.();
	}

	function clearRetryTimer(): void {
		if (!retryTimer) return;
		clearTimer(retryTimer);
		retryTimer = null;
	}

	function clearHeartbeatTimer(): void {
		if (!heartbeatTimer) return;
		clearTimer(heartbeatTimer);
		heartbeatTimer = null;
	}

	function updateState(nextState: ConsoleRegistrationState["state"], message: string): void {
		state = {
			state: nextState,
			attempts,
			message,
			...(activeRegistration ? {
				registrationId: activeRegistration.registrationId,
				endpoint: activeRegistration.endpoint.baseUrl,
			} : {}),
			bufferedEvents: buffer.length,
			droppedEvents,
		};
	}
}

function assertRegisterResponse(response: RegisterCliResponse): void {
	if (!response.registrationId || !response.ingestToken) {
		throw new Error("console register response is missing registration credentials");
	}
	if (!Number.isFinite(response.heartbeatIntervalMs) || response.heartbeatIntervalMs <= 0) {
		throw new Error("console register response has invalid heartbeat interval");
	}
	if (!Number.isFinite(response.leaseTtlMs) || response.leaseTtlMs <= 0) {
		throw new Error("console register response has invalid lease TTL");
	}
	if (!Number.isFinite(response.maxBatchEvents) || response.maxBatchEvents <= 0) {
		throw new Error("console register response has invalid max batch size");
	}
}

function computeAckRemovalCount(batch: readonly PushEventEnvelope[], ack: PushEventsResponse): number {
	const highest = Number.isFinite(ack.highestContiguousSeq) ? ack.highestContiguousSeq : 0;
	const contiguousCount = batch.filter((event) => event.seq <= highest).length;
	if (contiguousCount > 0) return contiguousCount;
	return Math.max(0, Math.min(batch.length, ack.accepted));
}

function normalizeBaseUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return null;
		url.hash = "";
		url.search = "";
		url.pathname = url.pathname.replace(/\/(?:mcp|console\/?)$/, "");
		return url.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}

function buildUrl(baseUrl: string, pathname: string): string {
	return `${baseUrl}${pathname}`;
}

function defaultConsoleBaseDir(channel: FleetCliChannel): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return path.join(os.tmpdir(), `${DEFAULT_CONSOLE_LOCK_DIR_NAME}-${uid}-${channel}`);
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
