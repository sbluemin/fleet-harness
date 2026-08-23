import { GATEWAY_PROVIDERS, type GatewayProvider } from "@dotobokuri/core-ai-gateway";

/**
 * 어떤 공급자의 모델로 실행되었는지. Operation payload에 영속되어 Console 크롬이
 * 사이드바·커맨드 밴드 글리프를 고르는 유일한 근거가 된다. 세션이 도는 동안 CLI 안에서
 * 모델을 바꿔도 이 값은 실행 시점 사실이라 움직이지 않는다.
 */
export type AgentLaunchProvider = "claude" | GatewayProvider;

// 게이트웨이 모델 id는 `${provider}--${model}`이고, 구분자가 없는 id는 Claude Code 순정 별칭이다.
const GATEWAY_MODEL_SEPARATOR = "--";

/** 실행 모델 id에서 공급자를 읽는다. 모델을 고르지 않은 실행은 순정 Claude다. */
export function agentLaunchProviderFromModel(model: string | undefined): AgentLaunchProvider {
  if (!model) return "claude";
  const separator = model.indexOf(GATEWAY_MODEL_SEPARATOR);
  if (separator <= 0) return "claude";
  const candidate = model.slice(0, separator);
  return GATEWAY_PROVIDERS.includes(candidate as GatewayProvider) ? candidate as GatewayProvider : "claude";
}

export function isAgentLaunchProvider(value: unknown): value is AgentLaunchProvider {
  return value === "claude" || GATEWAY_PROVIDERS.includes(value as GatewayProvider);
}
