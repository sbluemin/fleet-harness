/**
 * 사령관 채팅의 CLI 문 — 호스트가 사령관이 답할 수 있는지를 말하는 세 상태.
 *
 * `missing` — 사령관이 쓰는 리졸버로 `claude` 실행 파일을 찾지 못했다(설치·경로).
 * `signedout` — 실행 파일은 있지만 그 환경에서 Claude 로그인이 없다.
 * `ready` — 둘 다 갖춰졌거나, 판정 자체를 읽지 못해 보내기를 막을 근거가 없다(판정 실패는 막지 않는다).
 */
export type CommodoreCliStatus = "missing" | "signedout" | "ready";

export interface CommodoreCliStatusView {
  readonly status: CommodoreCliStatus;
}

/** 이 두 원인은 대화를 고칠 수 없고 화면이 해결 동선을 말해야 한다 — 자동 재시도도 멈춘다. */
export const COMMODORE_CLI_FAILURE_CODES = ["agent_cli_unavailable", "agent_signed_out"] as const;

const CAUSE_BY_CODE: Readonly<Record<string, "missing" | "signedout">> = {
  agent_cli_unavailable: "missing",
  agent_signed_out: "signedout",
};

export function commodoreCliCause(code: string | undefined): "missing" | "signedout" | null {
  return code !== undefined ? CAUSE_BY_CODE[code] ?? null : null;
}
