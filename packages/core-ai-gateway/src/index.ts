// Compatibility-only facade. Provider branching and behavior live in the provider
// folders; this file only re-exports the public surface from their new locations.
export * from "./downstream/wire/anthropic-messages/protocol.js";
export * from "./downstream/harness/claude-code/context.js";
export * from "./downstream/harness/claude-code/discovery.js";
export * from "./downstream/wire/anthropic-messages/inbound.js";
export * from "./downstream/wire/anthropic-messages/passthrough.js";
export * from "./upstream/anthropic/native.js";
export * from "./upstream/antigravity/index.js";
// Provider quota probes and the shared quota vocabulary. `CredentialMethod` is
// re-exported from transport/credentials.js (same closed shape), so the quota
// DTO types are re-listed explicitly to keep the facade unambiguous.
export type {
  ProviderStatus,
  WindowId,
  QuotaScope,
  WindowDurationBasis,
  WindowStartBasis,
  QuotaWindowPeriod,
  QuotaWindowAmounts,
  QuotaWindow,
  ResetCredits,
  ProviderDto,
  QuotaSummaryDto,
  ProviderSuccess,
  ProviderResult,
} from "./quota/types.js";
export * from "./quota/pressure.js";
export * from "./quota/windows.js";
export * from "./quota/service.js";
export * from "./upstream/anthropic/quota.js";
export * from "./upstream/anthropic/credentials.js";
export * from "./upstream/codex/quota.js";
export * from "./upstream/cursor/quota.js";
export * from "./upstream/kimi/quota.js";
export * from "./upstream/opencode-go/quota.js";
export * from "./upstream/xai/index.js";
export * from "./canonical/index.js";
export * from "./upstream/cursor/credentials.js";
export * from "./upstream/cursor/native/index.js";
export * from "./upstream/cursor/diagnostic-log.js";
export * from "./router/router.js";
export * from "./router/types.js";
export * from "./router/http.js";
export * from "./router/passthrough.js";
export * from "./router/opencode-dispatch.js";
export * from "./transport/credentials.js";
// wireLog/logCanonicalEvents 는 진단 구현 세부사항이므로 런타임 제어 표면만 좁게 공개한다.
export { DEFAULT_WIRE_LOG_MAX_BYTES, setWireLogTarget, wireLogEnabled } from "./transport/wire-log.js";
export type { WireLogTarget } from "./transport/wire-log.js";
// token-estimate.js 는 의도적으로 배럴 밖이다 — estimateTokens 는 이 패키지가 요청을
// 내보내기 전에 쓰는 내부 휴리스틱이고, 올리면 공개 계약이 넓어진다.
export { AnthropicMessagesGateway, ContextWindowExceededError } from "./downstream/wire/anthropic-messages/inbound.js";
export type { AnthropicGatewayCallOptions, AnthropicGatewayResponse } from "./downstream/wire/anthropic-messages/inbound.js";
export * from "./models.js";
// 공개 표기의 `findGatewayModel`은 Claude 표기까지 인정한다. 카탈로그 자신은 고유 id만 알고
// (`models.ts`), 접두·`[1m]` 표식은 Claude Code 하네스의 문법이다 — 다만 그 문법은 이미 발행돼
// 영속 세션·`ANTHROPIC_MODEL` 값·저장된 기본값에 들어 있고, 지금 이 패키지를 쓰는 호스트는 전부
// Claude Code 호스트다. 그래서 호환 파사드는 관대한 쪽을 이 이름으로 계속 내보낸다.
// 이 명시 export가 위 `export *`의 동명 항목을 가린다.
export { findClaudeGatewayModel as findGatewayModel } from "./downstream/harness/claude-code/discovery.js";
// 같은 이유로 `resolveGatewayModel`도 관대한 쪽을 내보낸다. 카탈로그 기본값은 고유 id만 알아서
// (`models.ts`의 `find` 기본값), 파사드가 그대로 두면 접두 붙은 영속 id가 조용히 fallback 모델로
// 떨어진다 — 호출자는 다른 업스트림으로 요청을 보내고도 그 사실을 모른다.
export { resolveClaudeGatewayModel as resolveGatewayModel } from "./downstream/harness/claude-code/discovery.js";
export * from "./auth/index.js";
export * from "./settings/index.js";
export * from "./settings/store.js";
export * from "./upstream/opencode-go/index.js";
export * from "./upstream/codex/credentials.js";
export * from "./upstream/codex/responses/index.js";
export * from "./upstream/kimi/index.js";
export * from "./transport/sse-keepalive.js";
export {
  DEFAULT_MAX_IN_FLIGHT_PER_ORIGIN,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  UpstreamQueueTimeoutError,
  createUpstreamGate,
} from "./transport/upstream-gate.js";
export type {
  UpstreamGate,
  UpstreamGateOptions,
  UpstreamGateOriginStats,
} from "./transport/upstream-gate.js";
export {
  DEFAULT_FAILURE_JOURNAL_MAX_BYTES,
  createFailureJournal,
  failureDetail,
} from "./transport/failure-journal.js";
export type {
  FailureJournal,
  FailureJournalOptions,
  GatewayFailurePhase,
  GatewayFailureRecord,
  GatewayFailureSink,
} from "./transport/failure-journal.js";
export {
  GATEWAY_TRANSIENT_ERROR_STATUS,
  claudeRetryableUpstreamStatus,
} from "./downstream/harness/claude-code/context.js";
