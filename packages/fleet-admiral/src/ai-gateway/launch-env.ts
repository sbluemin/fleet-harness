import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	GATEWAY_MODELS,
	buildAnthropicModelList,
	type AiGatewaySelection,
	type GatewayModel,
} from "@dotobokuri/core-ai-gateway";
import { writeAtomicSync } from "@dotobokuri/core-infra";

import type { AgentCliProfile } from "../agent-cli/types.js";

export interface AiGatewayLaunchEnvOptions {
	readonly baseUrl: string;
	readonly selection?: AiGatewaySelection;
	readonly homeDir?: string;
	readonly compactHookToken?: string;
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
		// 1M ceiling은 `[1m]` 모델의 선제 압축을 켜고, unmarked custom model에서는
		// Claude Code의 200k 좌표로 clamp된다. 명시적 운영자 override는 보존한다.
		CLAUDE_CODE_AUTO_COMPACT_WINDOW:
			profile.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "1000000",
		// Gateway가 tool_reference 계약을 보존한다. Cursor는 이를 지연 catalog 선택에 쓰고,
		// 호환 프로바이더 경계는 각자의 eager wire 형식으로 정규화한다.
		ENABLE_TOOL_SEARCH: "true",
		...(options.compactHookToken
			? {
				FLEET_COMPACT_BASE_URL: options.baseUrl,
				FLEET_COMPACT_HOOK_TOKEN: options.compactHookToken,
			}
			: {}),
	};
	writeClaudeGatewayModelCache(
		options.baseUrl,
		env,
		options.homeDir ?? os.homedir(),
		options.selection?.models ?? GATEWAY_MODELS,
	);
	// 자체 bearer는 주입하지 않는다. Claude Code가 이미 가진 OAuth 또는 환경변수 자격을 보내면
	// built-in Anthropic 모델은 그대로 중계하고, 다른 provider 분기는 Console 소유 자격으로 교체한다.
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
	return writeGatewayModelCacheForHome({ baseUrl, configDir, models: exposedModels });
}

/**
 * 한 Claude 홈의 discovery 캐시를 노출 모델 전체로 세운다.
 *
 * PTY 런처만의 일이 아니다 — 같은 홈을 쓰는 SDK 세션도 게이트웨이 별칭을 인정받으려면 이 캐시가
 * 서 있어야 하고, 홈이 공유이므로 **쓰는 쪽은 언제나 노출 목록 전체**를 써야 한다. 자기 세션의
 * 모델 하나로 좁혀 쓰면 같은 홈의 다른 자식이 나머지 별칭을 잃는다.
 */
export function writeGatewayModelCacheForHome(options: {
	readonly baseUrl: string;
	readonly configDir: string;
	readonly models?: readonly GatewayModel[];
}): string {
	const { baseUrl, configDir } = options;
	const exposedModels = options.models ?? GATEWAY_MODELS;
	const cacheDir = path.join(configDir, "cache");
	const cachePath = path.join(cacheDir, "gateway-models.json");
	const models = buildAnthropicModelList(exposedModels).data
		.filter((model) => /^(claude|anthropic)/i.test(model.id))
		.map((model) => ({ id: model.id, display_name: model.display_name }));

	fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	writeAtomicSync(cachePath, JSON.stringify({ baseUrl, fetchedAt: Date.now(), models }), { mode: 0o600 });
	return cachePath;
}
