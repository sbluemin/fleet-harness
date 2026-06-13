import { afterEach, describe, expect, it, vi } from "vitest";

interface RuntimeHarness {
	readonly cleanupPublisher: ReturnType<typeof vi.fn>;
	readonly createPublisher: ReturnType<typeof vi.fn>;
	readonly mcpServerStop: ReturnType<typeof vi.fn>;
	readonly publishJobEvent: ReturnType<typeof vi.fn>;
	readonly startPublisher: ReturnType<typeof vi.fn>;
	readonly streamRegister: ReturnType<typeof vi.fn>;
	readonly streamUnsubscribe: ReturnType<typeof vi.fn>;
}

afterEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
	vi.doUnmock("@dotobokuri/fleet-admiral");
	vi.doUnmock("@dotobokuri/fleet-carriers");
	vi.doUnmock("@dotobokuri/core-agent");
	vi.doUnmock("@dotobokuri/fleet-infra");
	vi.doUnmock("@dotobokuri/fleet-infra/auth");
	vi.doUnmock("@dotobokuri/fleet-infra/data-dir");
	vi.doUnmock("@dotobokuri/fleet-wiki");
	vi.doUnmock("../src/runtime/console-register-publisher.js");
	vi.doUnmock("../src/runtime/reconciliation.js");
	vi.doUnmock("../src/runtime/workspace-scanner.js");
});

describe("fleet runtime console registration gating", () => {
	it("does not start or subscribe the console publisher unless console registration is enabled", async () => {
		const harness = mockRuntimeDeps();
		const { createFleetRuntimeLifecycle } = await import("../src/runtime/runtime.js");
		const lifecycle = createFleetRuntimeLifecycle({ consoleRegister: false, dataDir: "/tmp/fleet-test" });

		await lifecycle.start();
		await lifecycle.shutdown();

		expect(harness.startPublisher).not.toHaveBeenCalled();
		expect(harness.streamRegister).not.toHaveBeenCalled();
		expect(harness.publishJobEvent).not.toHaveBeenCalled();
		expect(harness.cleanupPublisher).toHaveBeenCalledTimes(1);
		expect(harness.streamUnsubscribe).not.toHaveBeenCalled();
	});

	it("starts and subscribes the console publisher when console registration is enabled", async () => {
		const harness = mockRuntimeDeps();
		const { createFleetRuntimeLifecycle } = await import("../src/runtime/runtime.js");
		const lifecycle = createFleetRuntimeLifecycle({ consoleRegister: true, dataDir: "/tmp/fleet-test" });

		await lifecycle.start();
		const handler = harness.streamRegister.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
		handler?.({ type: "job:registered" });
		await lifecycle.shutdown();

		expect(harness.startPublisher).toHaveBeenCalledTimes(1);
		expect(harness.streamRegister).toHaveBeenCalledTimes(1);
		expect(harness.publishJobEvent).toHaveBeenCalledWith({ type: "job:registered" });
		expect(harness.streamUnsubscribe).toHaveBeenCalledTimes(1);
		expect(harness.cleanupPublisher).toHaveBeenCalledTimes(1);
	});

	it("passes process.env to the console publisher so FLEET_CONSOLE_SESSION_ID can resolve as the cliRunId", async () => {
		const harness = mockRuntimeDeps();
		const { createFleetRuntimeLifecycle } = await import("../src/runtime/runtime.js");
		const lifecycle = createFleetRuntimeLifecycle({ consoleRegister: true, dataDir: "/tmp/fleet-test" });

		await lifecycle.start();
		await lifecycle.shutdown();

		expect(harness.createPublisher).toHaveBeenCalledWith(expect.objectContaining({ env: process.env }));
	});
});

function mockRuntimeDeps(): RuntimeHarness {
	const cleanupPublisher = vi.fn(async () => undefined);
	const mcpServerStop = vi.fn(async () => undefined);
	const publishJobEvent = vi.fn();
	const startPublisher = vi.fn();
	const streamUnsubscribe = vi.fn();
	const streamRegister = vi.fn(() => streamUnsubscribe);
	const createPublisher = vi.fn(() => ({
		cleanup: cleanupPublisher,
		publishJobEvent,
		start: startPublisher,
	}));

	vi.doMock("@dotobokuri/fleet-carriers", () => ({
		createCarrierRuntime: () => ({
			jobs: {
				streaming: {
					register: streamRegister,
				},
			},
			registerCarrierDefaults: vi.fn(),
			registry: {
				getState: () => ({ modes: new Map() }),
			},
			store: {
				initStore: vi.fn(),
			},
		}),
	}));
	vi.doMock("@dotobokuri/fleet-admiral", () => ({
		FLEET_MCP_SERVER_NAME: "fleet",
		getExecutorMcpTools: () => [],
		registerAgentToolDefaults: vi.fn(),
	}));
	vi.doMock("@dotobokuri/core-agent", () => ({
		createExecutorSessionManager: () => ({
			cleanup: vi.fn(),
			createExecutorMcpSession: vi.fn(),
		}),
		createInProcessMcpServer: () => ({
			start: vi.fn(async () => undefined),
			stop: mcpServerStop,
		}),
		createMcpToolRegistry: () => ({
			getAllAgentTools: () => [],
			registerExecutorTool: vi.fn(),
		}),
		createMcpToolSnapshotStore: () => ({}),
		disconnectAll: vi.fn(async () => undefined),
		executorMcpRuntimeProviderRuntime: {
			register: vi.fn(),
		},
		executorPortRuntime: {
			register: vi.fn(),
		},
	}));
	vi.doMock("@dotobokuri/fleet-infra", () => ({
		createInfraServices: () => ({
			authService: {},
		}),
	}));
	vi.doMock("@dotobokuri/fleet-infra/auth", () => ({
		resolveAuthEnv: vi.fn(),
	}));
	vi.doMock("@dotobokuri/fleet-infra/data-dir", () => ({
		getFleetDataDir: () => "/tmp/fleet-data",
	}));
	vi.doMock("@dotobokuri/fleet-wiki", () => ({
		getWikiToolSpecs: () => [],
	}));
	vi.doMock("../src/runtime/console-register-publisher.js", () => ({
		createConsoleRegisterPublisher: createPublisher,
	}));
	vi.doMock("../src/runtime/reconciliation.js", () => ({
		reconcileRuntimeState: vi.fn(),
	}));
	vi.doMock("../src/runtime/workspace-scanner.js", () => ({
		createWorkspaceChangeScanner: () => ({}),
	}));

	return {
		cleanupPublisher,
		createPublisher,
		mcpServerStop,
		publishJobEvent,
		startPublisher,
		streamRegister,
		streamUnsubscribe,
	};
}
