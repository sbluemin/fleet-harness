import type { ClaudeGatewayEffort } from "@dotobokuri/core-agent/claude";

const WIRE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * 퀵런치 트랙의 launch sentinel을 Chat Mode SDK 시드로 옮긴다.
 *
 * `ultra`는 wire effort가 아니다. CLI의 `--effort ultracode`와 같이 `xhigh` 강도에
 * 세션 설정 `ultracode`(standing dynamic-workflow orchestration)를 얹는다. SDK
 * `Options.effort`에는 `ultracode`가 없고, `max`로 접으면 오케스트레이션이 빠진다.
 */
export type ChatLaunchEffortResolution = {
  readonly effort: ClaudeGatewayEffort;
  readonly ultracode?: true;
};

export function resolveChatLaunchEffort(value: string): ChatLaunchEffortResolution | undefined {
  if (value.length === 0) return undefined;
  if (value === "ultra") return { effort: "xhigh", ultracode: true };
  return (WIRE_EFFORTS as readonly string[]).includes(value)
    ? { effort: value as ClaudeGatewayEffort }
    : undefined;
}
