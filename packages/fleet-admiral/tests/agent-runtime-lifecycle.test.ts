import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFleetAgentRuntimeLifecycle } from "../src/agent-runtime/index.js";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-lifecycle-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("createFleetAgentRuntimeLifecycle cleanup ordering", () => {
	it("cancels and awaits in-flight one-shots before dedicated MCP and server teardown", async () => {
		const order: string[] = [];
		const lifecycle = createFleetAgentRuntimeLifecycle({
			dataDir: tempDir,
			onMcpServerStartError: () => { /* ignore MCP bind noise in tests */ },
		});

		// Observe the dedicated MCP session cleanup as an ordering marker; the real
		// teardown must not run before the Carrier runtime has drained its dispatches.
		vi.spyOn(lifecycle.dedicatedMcpSession, "cleanup").mockImplementation(() => {
			order.push("mcp-session-cleanup");
		});

		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
		lifecycle.carrierRuntime.trackInFlight({
			cancel: () => {
				order.push("cancel");
				resolveCompletion();
			},
			completion: completion.then(() => { order.push("await-completion"); }),
		});

		await lifecycle.cleanup();

		expect(order).toEqual(["cancel", "await-completion", "mcp-session-cleanup"]);
		expect(lifecycle.carrierRuntime.admission.accepting).toBe(false);
		expect(() => lifecycle.carrierRuntime.admission.assertOpen()).toThrow(/closed to new dispatches/);
		// The runtime-owned dispatch context registry is disposed as part of cleanup.
		expect(lifecycle.carrierRuntime.dispatchContexts.claim("resume-ctx", {
			carrierId: "genesis",
			cwd: "/tmp",
			shape: "single",
			backends: [{ cliType: "claude" }],
		})).toEqual({ accepted: false, error: "disposed" });
	});
});
