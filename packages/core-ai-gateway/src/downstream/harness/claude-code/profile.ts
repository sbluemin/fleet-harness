import type { GatewayModel } from "../../../models.js";
import type { AnthropicMessagesRequest } from "../../wire/anthropic-messages/protocol.js";
import type { CompactCeilingSetting, GatewayHarnessProfile } from "../contract.js";

import {
  GATEWAY_TRANSIENT_ERROR_STATUS,
  claudeRetryableUpstreamStatus,
  projectAnthropicResponseUsage,
  projectClaudeContextInputTokens,
  stripClaudeUsageLimitDirectives,
} from "./context.js";
import { buildAnthropicModelList, findClaudeGatewayModel } from "./discovery.js";

/** Claude Code가 claude.ai 구독으로 붙을 때 보내는 자격증명 접두. OAuth 토큰도 이 접두를 쓴다. */
const ANTHROPIC_CREDENTIAL_PREFIX = "sk-ant-";

/**
 * Claude Code as a gateway client.
 *
 * Every field here was an inline assumption in `router.ts` before a second harness
 * existed. Nothing about the behaviour changed when it moved: this profile is the
 * gateway's current serving contract, written down where the next client can state a
 * different answer beside it instead of adding a branch to the router.
 */
export const claudeCodeHarnessProfile: GatewayHarnessProfile = {
  id: "claude-code",
  wire: "anthropic-messages",
  // Claude Code는 base URL 뒤에 자기 경로를 붙인다. 연결 프로브는 /api/hello다.
  probePaths: ["/api/hello"],
  acceptsCredential: (credential) => credential.startsWith(ANTHROPIC_CREDENTIAL_PREFIX),
  findModel: findClaudeGatewayModel,
  buildModelList: (models: readonly GatewayModel[]) => buildAnthropicModelList(models),
  sanitizeRequest: (request: AnthropicMessagesRequest) => {
    // 하네스가 자기 Anthropic 계정의 한도 임박을 근거로 대화에 끼워 넣는 마무리 지시는 여기서 끊는다.
    // 그 지시는 이 턴을 실제로 결제하는 구독을 설명하지 않으므로, 목적지를 가리지 않고 전량 제거한다 —
    // 근거와 모양 판정은 이 폴더의 context.ts가 갖는다. 공급자별 판단이 아니므로 공급자 정책으로
    // 내려가지 않는다: 게이트웨이 대상이 없는 네이티브 Anthropic까지 덮어야 하는 유일한 다듬기다.
    const stripped = stripClaudeUsageLimitDirectives(request.messages);
    return stripped.changed ? { ...request, messages: [...stripped.messages] } : request;
  },
  usageProjection: (compactCeiling: CompactCeilingSetting) => (
    (inputTokens, advertisedContextWindow, upstreamContextWindow) => projectClaudeContextInputTokens(
      inputTokens,
      advertisedContextWindow,
      upstreamContextWindow,
      compactCeiling,
    )
  ),
  passthroughProjection: (compactCeiling: CompactCeilingSetting) => (
    (chunks, options) => projectAnthropicResponseUsage(chunks, {
      contentType: options.contentType,
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.responseModel === undefined ? {} : { responseModel: options.responseModel }),
      compactCeiling,
    })
  ),
  retryableStatus: claudeRetryableUpstreamStatus,
  transientErrorStatus: GATEWAY_TRANSIENT_ERROR_STATUS,
};

export { ANTHROPIC_CREDENTIAL_PREFIX };
