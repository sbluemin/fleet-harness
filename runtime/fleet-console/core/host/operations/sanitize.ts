import type { OperationNode } from "./types.js";

export interface OperationSanitizeOptions {
  readonly sensitiveFields?: readonly string[];
}

const FIXED_SENSITIVE_OPERATION_FIELDS = new Set([
  "canonicalCwd",
  "cwd",
  "persona",
  "prompt",
  "providerSession",
  "ticket",
  "token",
  "toolAllowlist",
  "transcriptPath",
]);

export function createSanitizedOpDto(node: OperationNode, options: OperationSanitizeOptions = {}): OperationNode {
  const sensitiveFields = new Set([...FIXED_SENSITIVE_OPERATION_FIELDS, ...(options.sensitiveFields ?? [])]);
  const payload = sanitizeRecord(node.payload, sensitiveFields);
  // providerSession은 브라우저에 못 나가지만, "재개 가능한 저장 세션이 있다"는 사실 자체는
  // 비민감 파생 정보다 — 복원 op의 dormant 분류(I2)가 이 마커에 의존한다.
  // 호스트 소유 상태이므로 호출자 주입분은 먼저 지우고, 형태 검증을 통과한 providerSession에서만
  // 파생한다(Codex P2) — 빈 객철만으로는 resume이 성립하지 않으므로 마커도 심지 않는다.
  delete payload.resumeAvailable;
  if (isResumableProviderSession(node.payload?.providerSession)) payload.resumeAvailable = true;
  return {
    ...node,
    payload,
  };
}

// resume 라우트의 readProviderSession보다 느슨한 도메인 중립 최소형: provider/sessionId가
// 비어있지 않은 문자열이면 마커를 허용한다. 그 이상의 형태 미스매치 잔여분은 Resume 시
// 프레임의 실패 카드(I1)가 사용자에게 표면화한다.
function isResumableProviderSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const provider = value.provider;
  const sessionId = value.sessionId;
  return typeof provider === "string" && provider.length > 0 && typeof sessionId === "string" && sessionId.length > 0;
}

function sanitizeRecord(value: Record<string, unknown>, sensitiveFields: ReadonlySet<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveFields.has(key)) continue;
    output[key] = sanitizeValue(item, sensitiveFields);
  }
  return output;
}

function sanitizeValue(value: unknown, sensitiveFields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, sensitiveFields));
  if (!isRecord(value)) return value;
  return sanitizeRecord(value, sensitiveFields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
