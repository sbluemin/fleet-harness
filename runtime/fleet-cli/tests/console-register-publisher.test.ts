import { describe, expect, it } from "vitest";

import { createConsoleRegisterPublisher } from "../src/runtime/console-register-publisher.js";

interface PostedRequest {
	readonly body: unknown;
	readonly path: string;
	readonly token?: string;
}

interface TestTimer {
	readonly callback: () => void;
	readonly ms: number;
	unref(): void;
}

const TEST_EVENT = {
	type: "job:registered",
	jobId: "job",
	kind: "single",
	ownerCarrierId: "carrier",
	label: "Job",
	startedAt: 1,
	tracks: [],
} as const;

describe("console register publisher", () => {
	it("keeps explicit cliRunId ahead of console session env", () => {
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "explicit-cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_SESSION_ID: "session-from-env" },
		});

		expect(publisher.cliRunId).toBe("explicit-cli-run");
	});

	it("uses the console session env as cliRunId when no explicit id is provided", () => {
		const publisher = createConsoleRegisterPublisher({
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_SESSION_ID: "session-from-env" },
		});

		expect(publisher.cliRunId).toBe("session-from-env");
	});

	it("falls back to a UUID cliRunId when explicit id and console session env are absent", () => {
		const publisher = createConsoleRegisterPublisher({
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: {},
		});

		expect(publisher.cliRunId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
	});

	it("starts fail-soft when the console is absent", async () => {
		const timers: TestTimer[] = [];
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			// 실제 ~/.fleet console lock을 줍지 않도록 존재하지 않는 경로로 고정해 console absent를 결정적으로 만든다.
			env: { FLEET_CONSOLE_LOCK_FILE: "/nonexistent-fleet-console/console.lock" },
			setTimeout: createTimerRecorder(timers),
		});

		expect(() => publisher.start()).not.toThrow();
		await waitFor(() => publisher.getConnectionState().state === "retrying");

		expect(publisher.getConnectionState()).toMatchObject({
			state: "retrying",
			bufferedEvents: 0,
		});
		expect(timers[0]?.ms).toBe(500);
		await publisher.cleanup();
	});

	it("registers and posts carrier events as acknowledged batches", async () => {
		const posts: PostedRequest[] = [];
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_ENDPOINT: "http://127.0.0.1:37283" },
			fetch: createFetchStub(posts),
		});

		publisher.start();
		publisher.publishJobEvent(TEST_EVENT);
		await waitFor(() => posts.length === 2);

		expect(posts.map((post) => post.path)).toEqual(["/api/cli/register", "/api/cli/events"]);
		expect(posts[0]?.body).toMatchObject({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			mcp: { servers: [{ name: "fleet", toolCount: 2 }] },
		});
		expect(posts[1]?.token).toBe("ingest-token");
		expect(posts[1]?.body).toEqual([
			{
				cliRunId: "cli-run",
				seq: 1,
				at: expect.any(String),
				event: TEST_EVENT,
			},
		]);
		expect(publisher.getConnectionState()).toMatchObject({
			state: "ready",
			bufferedEvents: 0,
			registrationId: "registration-id",
		});
		await publisher.cleanup();
	});

	it("keeps duplicate or stale acks from dropping buffered events", async () => {
		const posts: PostedRequest[] = [];
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_ENDPOINT: "http://127.0.0.1:37283" },
			fetch: createFetchStub(posts, { eventAck: { accepted: 0, highestContiguousSeq: 0 } }),
		});

		publisher.publishJobEvent(TEST_EVENT);
		await waitFor(() => publisher.getConnectionState().state === "retrying");

		expect(publisher.getConnectionState()).toMatchObject({
			state: "retrying",
			bufferedEvents: 1,
		});
		await publisher.cleanup();
	});

	it("uses a bounded lossy buffer when events arrive while offline", async () => {
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: {},
		});

		for (let index = 0; index < 300; index += 1) {
			publisher.publishJobEvent({ ...TEST_EVENT, jobId: `job-${index}` });
		}
		await settleAsync();

		expect(publisher.getConnectionState()).toMatchObject({
			bufferedEvents: 256,
			droppedEvents: 44,
		});
		await publisher.cleanup();
	});

	it("backs off and re-registers after a failed registration", async () => {
		const posts: PostedRequest[] = [];
		const timers: TestTimer[] = [];
		let registerAttempts = 0;
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_ENDPOINT: "http://127.0.0.1:37283" },
			fetch: createFetchStub(posts, {
				onRegister: () => {
					registerAttempts += 1;
					return registerAttempts === 1
						? new Response("nope", { status: 503 })
						: jsonResponse(registerResponse());
				},
			}),
			setTimeout: createTimerRecorder(timers),
		});

		publisher.publishJobEvent(TEST_EVENT);
		await waitFor(() => timers.length > 0);
		expect(publisher.getConnectionState().state).toBe("retrying");

		timers[0]!.callback();
		await waitFor(() => publisher.getConnectionState().state === "ready");

		expect(registerAttempts).toBe(2);
		expect(publisher.getConnectionState()).toMatchObject({
			state: "ready",
			bufferedEvents: 0,
		});
		await publisher.cleanup();
	});

	it("deregisters best-effort during cleanup", async () => {
		const posts: PostedRequest[] = [];
		const publisher = createConsoleRegisterPublisher({
			cliRunId: "cli-run",
			cwd: "/tmp/fleet",
			fleetVersion: "1.4.0",
			mcpServerName: "fleet",
			toolCount: 2,
			env: { FLEET_CONSOLE_ENDPOINT: "http://127.0.0.1:37283" },
			fetch: createFetchStub(posts, {
				onDeregister: () => new Response("ignored", { status: 500 }),
			}),
		});

		publisher.start();
		await waitFor(() => posts.length === 1);
		await expect(publisher.cleanup()).resolves.toBeUndefined();

		expect(posts.at(-1)).toMatchObject({
			path: "/api/cli/deregister",
			token: "ingest-token",
		});
	});
});

function createFetchStub(
	posts: PostedRequest[],
	options: {
		readonly eventAck?: { readonly accepted: number; readonly highestContiguousSeq: number };
		readonly onDeregister?: () => Response;
		readonly onRegister?: () => Response;
	} = {},
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/health") {
			return jsonResponse({ ok: true });
		}
		const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
		const token = parseBearerToken(init?.headers);
		posts.push({ path: url.pathname, body, token });
		if (url.pathname === "/api/cli/register") {
			return options.onRegister?.() ?? jsonResponse(registerResponse());
		}
		if (url.pathname === "/api/cli/events") {
			return jsonResponse(options.eventAck ?? { accepted: 1, highestContiguousSeq: 1 });
		}
		if (url.pathname === "/api/cli/heartbeat") {
			return jsonResponse({ accepted: true, leaseExpiresAt: new Date().toISOString() });
		}
		if (url.pathname === "/api/cli/deregister") {
			return options.onDeregister?.() ?? jsonResponse({ accepted: true });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

function createTimerRecorder(timers: TestTimer[]): (callback: () => void, ms: number) => TestTimer {
	return (callback, ms) => {
		const timer = { callback, ms, unref: () => undefined };
		timers.push(timer);
		return timer;
	};
}

function registerResponse() {
	return {
		registrationId: "registration-id",
		ingestToken: "ingest-token",
		heartbeatIntervalMs: 60_000,
		leaseTtlMs: 180_000,
		maxBatchEvents: 10,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function parseBearerToken(headers: HeadersInit | undefined): string | undefined {
	if (!headers || Array.isArray(headers)) return undefined;
	if (headers instanceof Headers) return headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
	return (headers as Record<string, string>).Authorization?.replace(/^Bearer\s+/i, "");
}

async function settleAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitFor(assertion: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (!assertion()) {
		if (Date.now() - startedAt > 1_000) throw new Error("Timed out waiting for condition");
		await settleAsync();
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
