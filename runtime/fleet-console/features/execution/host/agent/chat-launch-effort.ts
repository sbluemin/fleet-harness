import type { ClaudeGatewayEffort } from "@fleet-console/agent-runtime/claude";

const WIRE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * 새 세션 트랙의 launch 설정을 Chat Mode SDK 시드로 옮긴다.
 */
export type ChatLaunchEffortResolution = {
  readonly effort: ClaudeGatewayEffort;
};

export function resolveChatLaunchEffort(value: string): ChatLaunchEffortResolution | undefined {
  if (value.length === 0) return undefined;
  return (WIRE_EFFORTS as readonly string[]).includes(value)
    ? { effort: value as ClaudeGatewayEffort }
    : undefined;
}
