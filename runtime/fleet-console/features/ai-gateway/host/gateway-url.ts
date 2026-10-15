import { AI_GATEWAY_ROUTE_SEGMENT } from "@fleet-console/ai-gateway";

/** Console에 마운트된 AI Gateway의 기본 주소. Chat Mode가 같은 경로로 모델을 호출한다. */
export function resolveConsoleAiGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/api/v1/${AI_GATEWAY_ROUTE_SEGMENT}`;
}
