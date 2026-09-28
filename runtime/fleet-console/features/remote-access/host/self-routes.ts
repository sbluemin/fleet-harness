import type http from "node:http";

import type { AccessRegistry, AccessSession, ListenerIdentity } from "./auth.js";
import type { ControlReclaimedReason } from "./access-control-contract.js";

/**
 * 원격 세션이 스스로 떠나는 문.
 *
 * 원격 리스너 전용이고, 판정은 라우팅 앞의 중앙 admission이 이미 끝낸 세션 스냅샷으로 한다 —
 * 여기서 쿠키를 다시 풀어 다른 세션을 찾지 않는다. 그 세션 하나만 끝낸다.
 */
export const ACCESS_SELF_LEAVE_PATH = "/api/v1/access/self/leave";

/**
 * monitoring 세션에 허용되는 유일한 쓰기인가. 자기 접속을 끝내는 것은 권한 상승이 아니므로 연다.
 * 원문 URL로 정확히 가른다 — 쿼리, 접미 슬래시, 인코딩 변형, 업그레이드는 이 예외에 들지 않는다.
 */
export function isOwnSessionLeaveRequest(req: http.IncomingMessage): boolean {
  return req.method === "POST" && req.url === ACCESS_SELF_LEAVE_PATH && req.headers.upgrade === undefined;
}

export interface AccessSelfRoutesDeps {
  readonly access: Pick<AccessRegistry, "revokeSessionByHandle">;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly withSecurityHeaders: (headers?: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly forgetShell: (owner: string) => void;
  readonly endSessionStreams: (handle: string, reason: ControlReclaimedReason | null) => void;
  readonly broadcastControlChanged: () => void;
}

export function createAccessSelfRoutes(deps: AccessSelfRoutesDeps) {
  /**
   * 게스트가 스스로 떠난다. 세션만 끝내고 페어링은 남긴다 — 다음에 다시 열면 링크 없이 돌아온다.
   * 떠난 쪽에는 축출 안내를 보내지 않고, 이 기계의 커튼은 걷는다. 다른 세션을 지목할 자리는 두지 않는다.
   */
  function handleAccessSelfLeave(req: http.IncomingMessage, res: http.ServerResponse, listener: ListenerIdentity, session: AccessSession): void {
    if (req.method !== "POST") {
      deps.writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (req.url !== ACCESS_SELF_LEAVE_PATH || hasBody(req)) {
      deps.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (req.headers.origin !== listener.origin) {
      deps.writeJson(res, 403, { error: "origin_mismatch" });
      return;
    }
    deps.access.revokeSessionByHandle(session.handle);
    deps.forgetShell(session.handle);
    deps.endSessionStreams(session.handle, null);
    deps.broadcastControlChanged();
    res.writeHead(204, deps.withSecurityHeaders({}));
    res.end();
  }

  return { handleAccessSelfLeave };
}

function hasBody(req: http.IncomingMessage): boolean {
  const length = req.headers["content-length"];
  return req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}
