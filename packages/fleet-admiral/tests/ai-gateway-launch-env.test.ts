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

import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
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
			ENABLE_TOOL_SEARCH: "true",
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

	it("leaves Claude Code on its built-in default when configured default inheritance is disabled", () => {
		const selection = resolveAiGatewaySelection({
			version: 1,
			models: [{ id: "kimi--k3-256k" }],
			defaultModel: "kimi--k3-256k",
		});
		const prepared = prepareAiGatewayLaunchProfile(makeProfile(), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir: makeTemporaryDirectory(),
			selection,
			useConfiguredDefaultModel: false,
		});

		expect(prepared.env).not.toHaveProperty("ANTHROPIC_MODEL");
	});

	it("sets the configured default model only when the profile did not provide one", () => {
		const selection = resolveAiGatewaySelection({
			version: 1,
			models: [{ id: "kimi--k3-256k" }],
			defaultModel: "kimi--k3-256k",
		});
		const firstHome = makeTemporaryDirectory();
		const prepared = prepareAiGatewayLaunchProfile(makeProfile(), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir: firstHome,
			selection,
		});
		expect(prepared.env.ANTHROPIC_MODEL).toBe("claude-gateway--kimi--k3-256k");

		const secondHome = makeTemporaryDirectory();
		const preserved = prepareAiGatewayLaunchProfile(makeProfile({ ANTHROPIC_MODEL: "custom-model" }), {
			baseUrl: "http://127.0.0.1:4310/gateway",
			homeDir: secondHome,
			selection,
		});
		expect(preserved.env.ANTHROPIC_MODEL).toBe("custom-model");
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
		id: "claude-gateway",
		label: "Claude Gateway",
		bin: "claude",
		args: [],
		cwd: "/workspace",
		env,
		terminalName: "xterm-256color",
	};
}
