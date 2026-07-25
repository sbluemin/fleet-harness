import { describe, expect, it } from "vitest";

import type { GlobalOptionsService } from "@dotobokuri/core-infra";

import { createAuthEnvResolver } from "../src/agent-runtime/index.js";

function createServiceStub(load: GlobalOptionsService["load"]): GlobalOptionsService {
	return {
		load,
		save: (data) => data,
		update: (mutate) => mutate({ version: 1 }),
	};
}

describe("createAuthEnvResolver", () => {
	it("codex가 아닌 CLI에는 아무것도 주입하지 않는다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1 })));
		await expect(resolver("claude")).resolves.toEqual({});
	});

	it("Kimi carrier에는 Fleet 저장 키와 공식 endpoint env를 주입한다", async () => {
		const resolver = createAuthEnvResolver(undefined, {
			deleteApiKey: async () => false,
			getApiKey: async () => "kimi-secret",
			listProviderIds: async () => [],
			setApiKey: async () => {},
		});

		await expect(resolver("claude-kimi")).resolves.toMatchObject({
			ANTHROPIC_API_KEY: "kimi-secret",
			ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
		});
	});

	it("Kimi carrier에는 전역 설정의 기본 모델 env를 주입한다", async () => {
		const resolver = createAuthEnvResolver(
			createServiceStub(() => ({ version: 1, kimiModel: { model: "k3", effort: "low" } })),
			{
				deleteApiKey: async () => false,
				getApiKey: async () => "kimi-secret",
				listProviderIds: async () => [],
				setApiKey: async () => {},
			},
		);

		await expect(resolver("claude-kimi")).resolves.toMatchObject({
			ANTHROPIC_API_KEY: "kimi-secret",
			ANTHROPIC_MODEL: "k3",
			ANTHROPIC_DEFAULT_FABLE_MODEL: "k3",
			CLAUDE_CODE_EFFORT_LEVEL: "low",
			CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
		});
	});

	it("유효한 명시적 모델 컨텍스트는 전역 설정보다 우선한다", async () => {
		const resolver = createAuthEnvResolver(
			createServiceStub(() => ({ version: 1, kimiModel: { model: "k3" } })),
			{
				deleteApiKey: async () => false,
				getApiKey: async () => "kimi-secret",
				listProviderIds: async () => [],
				setApiKey: async () => {},
			},
		);

		await expect(resolver("claude-kimi", { model: "k3[1m]" })).resolves.toMatchObject({
			ANTHROPIC_MODEL: "k3[1m]",
			CLAUDE_CODE_EFFORT_LEVEL: "high",
			CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
		});
	});

	it("globalOptionsService가 없으면 아무것도 주입하지 않는다", async () => {
		const resolver = createAuthEnvResolver(undefined);
		await expect(resolver("codex")).resolves.toEqual({});
	});

	it("codex에는 전송 모드 환경변수를 주입하지 않는다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1 })));
		await expect(resolver("codex")).resolves.toEqual({});
	});
});
