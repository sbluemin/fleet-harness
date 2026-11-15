import { createHash, randomUUID } from "node:crypto";

import { OPENCODE_GO_USER_AGENT } from "./coordinates.js";

/**
 * 모든 OpenCode Go 요청이 싣는 클라이언트 정체성 헤더.
 *
 * 문서는 서드파티 클라이언트에 두 가지를 요구한다: 자기 user agent, 그리고 대화마다 안정적인
 * `x-opencode-session`(라우팅·프롬프트 캐시용). 원본 사용자 정보는 노출하지 않고, 같은 대화는
 * 요청·wire가 달라도 같은 라우팅 키를 쓴다.
 */
export function opencodeSessionHeaders(userId: unknown): Record<string, string> {
  const identity = typeof userId === "string" ? userId.trim() : "";
  // 정체성이 없는 독립 호출은 서로 합치지 않는다. 프로세스 공용 ID는 다른 대화를 섞는다.
  const session = identity
    ? createHash("sha256").update("fleet:opencode:session:").update(identity).digest("hex")
    : randomUUID();
  return { "user-agent": OPENCODE_GO_USER_AGENT, "x-opencode-session": session };
}
