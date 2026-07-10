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
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1, codexLaunchMode: "app-server" })));
		await expect(resolver("claude")).resolves.toEqual({});
	});

	it("globalOptionsService가 없으면 아무것도 주입하지 않는다", async () => {
		const resolver = createAuthEnvResolver(undefined);
		await expect(resolver("codex")).resolves.toEqual({});
	});

	it("codexLaunchMode 미저장 시 주입하지 않아 process.env 폴백을 보존한다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1 })));
		await expect(resolver("codex")).resolves.toEqual({});
	});

	it("저장된 acp 모드는 CODEX_USE_ACP=true로 주입한다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1, codexLaunchMode: "acp" })));
		await expect(resolver("codex")).resolves.toEqual({ CODEX_USE_ACP: "true" });
	});

	it("저장된 app-server 모드는 CODEX_USE_ACP=false로 주입한다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => ({ version: 1, codexLaunchMode: "app-server" })));
		await expect(resolver("codex")).resolves.toEqual({ CODEX_USE_ACP: "false" });
	});

	it("설정 로드가 실패하면 빈 객체로 폴백한다", async () => {
		const resolver = createAuthEnvResolver(createServiceStub(() => {
			throw new Error("settings unavailable");
		}));
		await expect(resolver("codex")).resolves.toEqual({});
	});
});
