// Operation 생성 메뉴용 Agent CLI 목록에 설치(available)·로그인(signedIn) 상태를 결합하는 순수 로직.
//
// 정책을 새로 만들지 않고 기존 SSoT만 합친다: 설치 여부는 cliCommand(바이너리) 기준 탐지 결과로 판정한다.
// available/signedIn은 불린만 노출하며 경로·버전·providerId는 싣지 않는다(Token Boundary).
// IO(탐지)는 호출자가 수행하고, 이 함수는 결합만 담당하므로 환경에 의존하지 않는 deterministic 단위 테스트가 가능하다.

import { CLI_BACKENDS } from "@dotobokuri/core-unified-agent";
import type { AgentCliId } from "@dotobokuri/fleet-admiral";

export interface AgentCliLaunchMetadata {
  readonly id: AgentCliId;
  readonly label: string;
  readonly available: boolean;
  readonly signedIn: boolean;
}

export interface AgentCliInstallStatus {
  // 탐지 단위인 바이너리 명령(cliCommand): claude/cursor-agent.
  readonly id: string;
  readonly available: boolean;
}

export function combineAgentCliLaunchMetadata(
  metadata: readonly { readonly id: AgentCliId; readonly label: string }[],
  installStatuses: readonly AgentCliInstallStatus[],
): AgentCliLaunchMetadata[] {
  const availableByCommand = new Map(installStatuses.map((entry) => [entry.id, entry.available]));
  return metadata.map((meta) => ({
    id: meta.id,
    label: meta.label,
    available: availableByCommand.get(resolveCliCommand(meta.id)) ?? false,
    signedIn: true,
  }));
}

// claude-native / claude-gateway는 Launch 전용이라 CLI_BACKENDS(Carrier/Analyst 전송 카탈로그)에 등재하지 않는다.
// 실행 바이너리는 claude와 같으므로 설치 판정도 claude를 따른다.
function resolveCliCommand(id: AgentCliId): string {
  return id === "claude-gateway" || id === "claude-native" ? "claude" : CLI_BACKENDS[id].cliCommand;
}
