import { createHash, randomUUID } from "node:crypto";

/** 원본 사용자 정보는 노출하지 않고, 같은 대화는 요청·wire가 달라도 같은 라우팅 키를 쓴다. */
export function opencodeSessionHeaders(userId: unknown): Record<string, string> {
  const identity = typeof userId === "string" ? userId.trim() : "";
  // 정체성이 없는 독립 호출은 서로 합치지 않는다. 프로세스 공용 ID는 다른 대화를 섞는다.
  const session = identity
    ? createHash("sha256").update("fleet:opencode:session:").update(identity).digest("hex")
    : randomUUID();
  return { "x-opencode-session": session };
}
