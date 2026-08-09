import { buildAnthropicModelList, type GatewayModel } from "@dotobokuri/core-ai-gateway";

/**
 * Claude Code 자식이 게이트웨이를 향하게 만드는 환경과, 그것이 모델을 인정하게 만드는 캐시.
 *
 * 이 계약은 `packages/fleet-admiral/src/ai-gateway/launch-env.ts`와 의도적으로 중복이다. Admiral은
 * 사용자의 실제 `~/.claude`를 대상으로 PTY를 띄우고 Fleet의 세션 기본 모델 정책을 소유한다. 여기는
 * 격리 config dir과 `settingSources: []`를 강제하는 SDK 정책을 소유한다. 공통 helper로 뽑으면 SDK를
 * 전혀 쓰지 않는 모든 Admiral 소비자가 vendor SDK 의존을 끌어오고, shared-home과 isolated-home이라는
 * 반대 정책이 파라미터 하나 뒤에 숨는다. Claude Code가 이 비문서화 계약을 바꾸면 두 곳을 함께 고친다.
 */

export const CLAUDE_GATEWAY_MODEL_CACHE_RELPATH = "cache/gateway-models.json";

export interface ClaudeGatewayLaunchEnvOptions {
  readonly baseUrl: string;
  /**
   * 격리 `CLAUDE_CONFIG_DIR`.
   *
   * 이것만 옮기면 로그인이 끊긴다. Claude Code는 keychain service 이름을 config dir의
   * sha256 앞 8자로 파생시키므로, 옮긴 config dir은 존재하지 않는 keychain 항목을 찾는다.
   * `CLAUDE_SECURESTORAGE_CONFIG_DIR`을 빈 문자열로 두면 그 접미사가 사라져 기본
   * `Claude Code-credentials` 항목을 그대로 쓴다. 두 변수는 하나의 메커니즘이다 — 한쪽만 세우면
   * 자식이 `Not logged in`으로 죽는다.
   */
  readonly configDir: string;
}

/**
 * 자식에게 넘길 완성된 환경을 만든다. 삭제까지 반영된 최종본이며, 부작용이 없다.
 *
 * SDK의 `env` 옵션은 `process.env`와 병합되지 않고 대체한다. 그래서 상속본을 여기서 펼친다.
 */
export function claudeGatewayLaunchEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  options: ClaudeGatewayLaunchEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) env[key] = value;
  }

  // Claude Code가 이 뒤에 /v1/messages를 붙인다.
  env.ANTHROPIC_BASE_URL = options.baseUrl;
  env.CLAUDE_CONFIG_DIR = options.configDir;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
  // 이게 있어야 게이트웨이 별칭 모델이 유효한 것으로 인정된다.
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  // Gateway가 tool_reference 계약을 보존한다.
  env.ENABLE_TOOL_SEARCH = "true";

  // 자체 bearer를 주입하지 않는다. 주입하면 Claude Code가 claude.ai OAuth 대신 그것을 보내고,
  // 게이트웨이의 sk-ant-* 호출자 게이트를 통과할 자격증명이 사라진다.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  // Fleet 터미널에서 기동된 프로세스는 Admiral이 세운 ANTHROPIC_MODEL을 상속한다. 그 값은 다른
  // 게이트웨이를 가리키므로 격리 자식으로 따라 들어오면 안 된다. 모델은 턴이 명시한다.
  delete env.ANTHROPIC_MODEL;

  return env;
}

export interface ClaudeGatewayModelCache {
  readonly baseUrl: string;
  readonly fetchedAt: number;
  readonly models: readonly { readonly id: string; readonly display_name: string }[];
}

/**
 * Claude Code가 구독 자격증명으로 동작하는 동안 읽는 discovery 캐시의 내용.
 *
 * 이 파일의 `baseUrl`이 자식의 `ANTHROPIC_BASE_URL`과 글자 단위로 같아야만 캐시가 인정된다.
 * 어긋나면 게이트웨이 별칭은 물론 내장 Anthropic 모델까지 거절된다.
 */
export function claudeGatewayModelCache(options: {
  readonly baseUrl: string;
  readonly models: readonly GatewayModel[];
  readonly fetchedAt: number;
}): ClaudeGatewayModelCache {
  const models = buildAnthropicModelList(options.models).data
    // Claude Code는 claude/anthropic 접두 id만 모델로 인정한다. 게이트웨이 별칭은 전부 통과한다.
    .filter((model) => /^(claude|anthropic)/i.test(model.id))
    .map((model) => ({ id: model.id, display_name: model.display_name }));
  return { baseUrl: options.baseUrl, fetchedAt: options.fetchedAt, models };
}
