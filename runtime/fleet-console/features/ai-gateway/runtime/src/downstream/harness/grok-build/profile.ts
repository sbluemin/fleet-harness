import type { GatewayModel } from "../../../models.js";
import type { GatewayHarnessProfile } from "../contract.js";

import { buildGrokModelList, findGrokGatewayModel } from "./discovery.js";

/**
 * Grok Build가 대화를 식별하는 헤더.
 *
 * 실측(grok 1.0.5, 2026-08-23): 한 세션의 모든 턴이 같은 UUID를 두 헤더에 함께 싣는다.
 * `x-grok-session-id`를 먼저 읽고 `x-grok-conv-id`로 물러난다 — 세션이 더 넓은 단위라
 * 대화가 갈려도 같은 값을 유지한다. 세션 시작 전 보조 턴은 둘 다 빈 문자열로 보내며,
 * 그런 턴은 정체성이 없는 것으로 다룬다.
 */
const GROK_SESSION_HEADERS = ["x-grok-session-id", "x-grok-conv-id"] as const;

/**
 * Grok Build as a gateway client.
 *
 * 이 프로필이 Claude Code와 다른 자리는 전부 Grok Build 쪽의 관측된 사실에서 나온다.
 * 하나하나가 라우터의 분기가 아니라 여기 적힌 답이라는 점이, 세 번째 클라이언트가 왔을 때
 * 이 파일 옆에 자기 답을 적으면 되는 이유다.
 */
export const grokBuildHarnessProfile: GatewayHarnessProfile = {
  id: "grok-build",
  wire: "anthropic-messages",
  // Grok Build는 첫 턴 전에 아무 경로도 두드리지 않는다. 실측에서 첫 요청이 곧 본 요청이었다.
  probePaths: [],
  // 자격증명은 Grok Build의 OIDC 세션 토큰이다 — Fleet이 써 주는 config는 `api_key`를 담지 않고,
  // 로그인된 상태를 전제로 세션 토큰이 그 자리에 온다. 그 토큰에는 안정적인 접두가 없고,
  // 엔터프라이즈 `auth_provider_command`는 임의 형식 값을 낸다. 그래서 모양 검사는 존재 여부까지다.
  // 게이트웨이는 값을 읽지 않으며 이것은 인증이 아니다 — 아무것도 안 보낸 호출자만 거른다.
  acceptsCredential: (credential) => credential.length > 0,
  findModel: findGrokGatewayModel,
  // 카탈로그가 못 찾은 id는 전부 거절한다. Claude Code 쪽은 접두 없는 id를 자기 네이티브 모델로
  // 보고 Anthropic으로 중계하지만, Grok Build에게 그 중계는 의미가 없을 뿐 아니라 위험하다:
  // 이 클라이언트는 세션마다 자기 내장 모델 id로 **제목 생성 보조 턴**을 같은 base_url로 보내고
  // (실측: `model: "grok-4.6"`, 본문에 사용자 질의 원문 포함), 중계를 허용하면 그 본문이
  // api.anthropic.com으로 나간다. 사용자가 고르지 않은 목적지다.
  relaysUnmatchedModel: () => false,
  buildModelList: (models: readonly GatewayModel[]) => buildGrokModelList(models),
  // 이 클라이언트가 대화에 끼워 넣는, 목적지를 잘못 설명하는 지시는 관측되지 않았다.
  sanitizeRequest: (request) => request,
  resolveSessionIdentity: (headers) => {
    for (const name of GROK_SESSION_HEADERS) {
      const value = headers[name];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
  },
  // 사용량 투영이 없다 — 이것이 이 프로필을 만드는 이유다. Grok Build는 창 크기를 자기
  // `[model.<id>].context_window` 설정에서 읽고, Fleet이 그 값에 공급자의 실제 창을 써 준다.
  // Claude Code의 200k/1M 좌표로 환산하면(실측 배율 0.637) 이 클라이언트의 미터와 자동 압축
  // 시점이 둘 다 틀린다. 그래서 usageProjection과 passthroughProjection을 선언하지 않는다.
  //
  // retryableStatus도 선언하지 않는다. Grok Build의 재시도 예산이 어느 상태 코드에 반응하는지
  // 아직 실측하지 않았고, 측정 없이 Claude Code의 목록을 복사하면 이 클라이언트가 재시도하지
  // 않는 코드로 전환해 턴을 죽일 수 있다. 부재는 업스트림 상태를 그대로 전달한다.
  //
  // 게이트웨이 자신의 일시적 실패는 500으로 보고한다. Grok Build의 오류 분류가 `server_error`로
  // 읽는 자리이고, 이 클라이언트의 기본 `max_retries`는 8이다.
  transientErrorStatus: 500,
};
