// 브라우저로 나가는 Agent CLI 가용성 DTO. Token Boundary 하드룰에 따라 raw filesystem path는
// 절대 포함하지 않는다. 바이너리 식별자(cliCommand)·표시명·설치 여부·버전만 표면화한다.

export interface AgentCliStatus {
  // 바이너리 식별자(= CLI_BACKENDS의 cliCommand). 예: "claude", "codex", "opencode", "cursor-agent".
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  // 설치되어 있고 `--version` 파싱에 성공한 경우의 버전 문자열. 그 외에는 null.
  readonly version: string | null;
}

export interface AgentCliState {
  readonly clis: readonly AgentCliStatus[];
}
