import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareAiGatewayLaunchProfile } from "../src/index.js";
import type { AgentCliProfile } from "../src/agent-cli/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		chmodSync(directory, 0o700);
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("prepareAiGatewayLaunchProfile", () => {
	it("copies the profile, sets gateway env, preserves Anthropic credentials, and writes the fallback cache", () => {
		const homeDir = makeTemporaryDirectory();
		const profile = makeProfile({
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_API_KEY: "key",
		});

		const prepared = prepareAiGatewayLaunchProfile(profile, {
			baseUrl: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
			homeDir,
			compactHookToken: "compact-token",
		});

		expect(prepared).not.toBe(profile);
		expect(prepared.env).not.toBe(profile.env);
		expect(profile.env).toMatchObject({
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_API_KEY: "key",
		});
		expect(prepared.env).toMatchObject({
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_API_KEY: "key",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
			CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
			ENABLE_TOOL_SEARCH: "true",
			FLEET_COMPACT_BASE_URL: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
			FLEET_COMPACT_HOOK_TOKEN: "compact-token",
		});

		const cachePath = path.join(homeDir, ".claude", "cache", "gateway-models.json");
		const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
			readonly baseUrl: string;
			readonly models: readonly { readonly id: string }[];
		};
		expect(cache.baseUrl).toBe("http://127.0.0.1:4310/plugins/terminal/ai-gateway");
		expect(cache.models.length).toBeGreaterThan(0);
		expect(cache.models.every((model) => /^(claude|anthropic)/i.test(model.id))).toBe(true);
		expect(statSync(cachePath).mode & 0o777).toBe(0o600);
	});

	it("omits compact hook env when the host did not provide a process token", () => {
		const prepared = prepareAiGatewayLaunchProfile(makeProfile(), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir: makeTemporaryDirectory(),
		});
		expect(prepared.env.FLEET_COMPACT_BASE_URL).toBeUndefined();
		expect(prepared.env.FLEET_COMPACT_HOOK_TOKEN).toBeUndefined();
	});

	it("preserves an explicit auto-compact ceiling", () => {
		const homeDir = makeTemporaryDirectory();
		const prepared = prepareAiGatewayLaunchProfile(makeProfile({
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "850000",
		}), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir,
		});

		expect(prepared.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("850000");
	});

	it("throws for an invalid base URL before writing a cache", () => {
		const homeDir = makeTemporaryDirectory();
		expect(() => prepareAiGatewayLaunchProfile(makeProfile(), {
			baseUrl: "not a URL",
			homeDir,
		})).toThrow();
		expect(() => readFileSync(path.join(homeDir, ".claude", "cache", "gateway-models.json"))).toThrow();
	});

	it("throws when the discovery cache cannot be written", () => {
		const homeDir = makeTemporaryDirectory();
		const configPath = path.join(homeDir, "not-a-directory");
		writeFileSync(configPath, "occupied");

		expect(() => prepareAiGatewayLaunchProfile(makeProfile({ CLAUDE_CONFIG_DIR: configPath }), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir,
		})).toThrow();
	});
});

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-gateway-env-"));
	temporaryDirectories.push(directory);
	return directory;
}

function makeProfile(env: Record<string, string> = {}): AgentCliProfile {
	return {
		id: "claude",
		label: "Claude Gateway",
		bin: "claude",
		args: [],
		cwd: "/workspace",
		env,
		terminalName: "xterm-256color",
	};
}
