import { readClaudeSessionTitle } from "@dotobokuri/core-agent/claude";

/**
 * 진행 중인 Operation의 표시 제목을 자식이 남긴 세션 기록에서 읽는 어댑터.
 *
 * 예전에는 provider별 갈래를 가진 공용 resolver를 ACP 패키지에서 받아 썼다. 이 플러그인이 띄우는
 * Agent CLI는 claude 하나뿐이라 — `AgentCliId`는 `claude-gateway`뿐이고 그 실행 바이너리가
 * claude다 — codex 갈래는 도달할 수 없는 코드였고, 함께 사라졌다.
 */
export interface SessionIdentityResolver {
  resolve(providerSessionId: string): Promise<string | null>;
}

export interface SessionIdentityResolverOptions {
  readonly cwd: string;
}

export function createSessionIdentityResolver(options: SessionIdentityResolverOptions): SessionIdentityResolver {
  return { resolve: (sessionId) => readClaudeSessionTitle(sessionId, options.cwd) };
}
