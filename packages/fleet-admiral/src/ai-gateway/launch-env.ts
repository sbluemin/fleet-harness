import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	GATEWAY_MODELS,
	buildAnthropicModelList,
	toClaudeGatewayModelId,
	type AiGatewaySelection,
} from "@dotobokuri/core-ai-gateway";
import { writeAtomicSync } from "@dotobokuri/core-infra";

import type { AgentCliProfile } from "../agent-cli/types.js";

export interface AiGatewayLaunchEnvOptions {
	readonly baseUrl: string;
	readonly selection?: AiGatewaySelection;
	readonly homeDir?: string;
}

export function prepareAiGatewayLaunchProfile(
	profile: AgentCliProfile,
	options: AiGatewayLaunchEnvOptions,
): AgentCliProfile {
	new URL(options.baseUrl);
	const env: Record<string, string> = {
		...profile.env,
		// Claude Code가 이 뒤에 /v1/messages를 붙인다.
		ANTHROPIC_BASE_URL: options.baseUrl,
		// 이게 있어야 /model picker가 게이트웨이의 GET /v1/models를 조회한다.
		CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
		// Gateway가 tool_reference 계약을 보존한다. Cursor는 이를 지연 catalog 선택에 쓰고,
		// 호환 프로바이더 경계는 각자의 eager wire 형식으로 정규화한다.
		ENABLE_TOOL_SEARCH: "true",
	};
	// Marked provider usage is projected onto Claude Code's 1M coordinate, so its
	// native auto policy remains model-relative. Do not inject the process-wide
	// compact-window override: it would also retune built-in Claude models. An
	// explicit user value already present in profile.env remains untouched above.
	if (options.selection?.defaultModel && !env.ANTHROPIC_MODEL) {
		// AI Gateway 설정의 세션 기본 모델. 프로필 env가 명시한 값이 항상 이긴다.
		env.ANTHROPIC_MODEL = toClaudeGatewayModelId(options.selection.defaultModel);
	}
	writeClaudeGatewayModelCache(
		options.baseUrl,
		env,
		options.homeDir ?? os.homedir(),
		options.selection?.models ?? GATEWAY_MODELS,
	);
	// 자체 bearer를 주입하지 않는다. 주입하면 Claude Code가 claude.ai OAuth 대신 그것을 보내고,
	// Anthropic 모델을 원문 중계할 자격증명이 사라져 게이트웨이가 토큰을 대신 읽는 우회가 된다.
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.ANTHROPIC_API_KEY;
	return { ...profile, env };
}

/**
 * Claude Code does not refresh gateway discovery while it relies on its own
 * subscription credential. Pre-write the cache schema it reads in that mode.
 */
function writeClaudeGatewayModelCache(
	baseUrl: string,
	env: Readonly<NodeJS.ProcessEnv>,
	homeDir: string,
	exposedModels = GATEWAY_MODELS,
): string {
	const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
		? env.CLAUDE_CONFIG_DIR
		: path.join(homeDir, ".claude");
	const cacheDir = path.join(configDir, "cache");
	const cachePath = path.join(cacheDir, "gateway-models.json");
	const models = buildAnthropicModelList(exposedModels).data
		.filter((model) => /^(claude|anthropic)/i.test(model.id))
		.map((model) => ({ id: model.id, display_name: model.display_name }));

	fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	writeAtomicSync(cachePath, JSON.stringify({ baseUrl, fetchedAt: Date.now(), models }), { mode: 0o600 });
	return cachePath;
}
