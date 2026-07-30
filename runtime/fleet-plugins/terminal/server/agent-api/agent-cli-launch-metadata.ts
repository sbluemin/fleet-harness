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
  // 탐지 단위인 바이너리 명령(cliCommand): claude/codex/cursor-agent.
  readonly id: string;
  readonly available: boolean;
}

export interface AgentCliAuthStatus {
  readonly cli: string;
  readonly signedIn: boolean;
}

export function combineAgentCliLaunchMetadata(
  metadata: readonly { readonly id: AgentCliId; readonly label: string }[],
  installStatuses: readonly AgentCliInstallStatus[],
  authStatuses: readonly AgentCliAuthStatus[],
): AgentCliLaunchMetadata[] {
  const availableByCommand = new Map(installStatuses.map((entry) => [entry.id, entry.available]));
  const signedInByCli = new Map(authStatuses.map((entry) => [entry.cli, entry.signedIn]));
  return metadata.map((meta) => ({
    id: meta.id,
    label: meta.label,
    available: availableByCommand.get(CLI_BACKENDS[meta.id].cliCommand) ?? false,
    signedIn: signedInByCli.has(meta.id) ? (signedInByCli.get(meta.id) ?? false) : true,
  }));
}
