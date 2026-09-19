import type * as http from "node:http";
import { expirePairingCookie, formatPairingCookie, formatSessionCookie, readPairingCookie, type AccessSession, type ListenerIdentity, type createAccessRegistry } from "./auth.js";
import { PAIRED_DEVICE_LIMIT, type createPairedDeviceStore } from "./paired-devices.js";
import { normalizeRemoteJoinSource, type createRemoteJoinGuard } from "./remote-join-guard.js";
import type { ControlReclaimedReason } from "./access-control-contract.js";
interface PairingRouteDeps {
  readonly access: ReturnType<typeof createAccessRegistry>;
  readonly pairedDeviceStore: ReturnType<typeof createPairedDeviceStore>;
  readonly remoteJoinGuard: ReturnType<typeof createRemoteJoinGuard>;
  readonly listenerForRequest: (req: http.IncomingMessage) => ListenerIdentity | null;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly withSecurityHeaders: (extra: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly broadcastControlChanged: () => void;
  readonly forgetShell: (handle: string) => void;
  readonly endSessionStreams: (handle: string, reason: ControlReclaimedReason | null) => void;
}
export function createPairingRoutes(deps: PairingRouteDeps) {
  const { access, pairedDeviceStore, remoteJoinGuard, listenerForRequest, readJsonBody, writeJson, withSecurityHeaders, broadcastControlChanged, forgetShell, endSessionStreams } = deps;
  async function handleAccessJoin(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const listener = listenerForRequest(req);
    if (!listener) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    // 루프백은 이 기계 앞에 앉은 사람이라 예산을 두지 않는다. 인터넷을 향한 문만 계량한다.
    if (listener.audience !== "remote") return performAccessJoin(req, res, listener);
    const source = normalizeRemoteJoinSource(req.socket.remoteAddress);
    const verdict = remoteJoinGuard.begin(source);
    if (verdict !== "ok") {
      // 본문을 읽기 전에 끝낸다 — 거절의 값이 요청의 값보다 싸야 예산이 뜻을 가진다.
      res.writeHead(verdict === "throttled" ? 429 : 503, withSecurityHeaders({
        "Content-Type": "application/json",
        "Retry-After": String(remoteJoinGuard.retryAfterSeconds(source)),
      }));
      res.end(JSON.stringify({ error: verdict === "throttled" ? "too_many_attempts" : "busy" }));
      return true;
    }
    let paired = false;
    try {
      paired = await performAccessJoin(req, res, listener);
    } finally {
      remoteJoinGuard.settle(source, paired ? "paired" : "rejected");
    }
    return true;
  }

  /** 조인 본체. 반환값은 "페어링에 성공했는가"이며, 응답은 이 안에서 끝난다. */
  async function performAccessJoin(req: http.IncomingMessage, res: http.ServerResponse, listener: ListenerIdentity): Promise<boolean> {
    const body = await readJsonBody<{ readonly token?: unknown; readonly device?: unknown }>(req);
    const token = isPlainObject(body) && typeof body.token === "string" ? body.token : null;
    const device = isPlainObject(body) ? sanitizeDeviceName(body.device) : null;
    const joined = token === null
      ? resumePairedDevice(req, listener, device)
      : pairFromGrant(listener, token, device);
    if ("error" in joined) {
      /**
       * 페어링만 내밀었는데 거절당했다면 그 쿠키는 이제 아무것도 열지 못한다 — 회수되었거나,
       * 신원이 갱신되었거나, 이 콘솔이 그 기기를 애초에 모른다. 지워 주지 않으면 그 기기는
       * 시도할 때마다 죽은 값을 다시 보낸다.
       */
      if (token === null && joined.status === 401) {
        res.writeHead(401, withSecurityHeaders({
          "Content-Type": "application/json",
          "Set-Cookie": expirePairingCookie({ secure: listener.secure, port: listener.port }),
        }));
        res.end(JSON.stringify({ error: joined.error }));
        return false;
      }
      writeJson(res, joined.status, { error: joined.error });
      return false;
    }
    /**
     * 등급을 가리지 않고 알린다. 원격 접속이 하나뿐이므로 monitoring 조인도 앞선 보유자를
     * 대신하고, 그때 커튼은 걷혀야 한다. 실제로 바뀌지 않은 사실은 브로드캐스트가 걸러낸다.
     */
    if (listener.audience === "remote") broadcastControlChanged();
    // 평문 http 리스너에 Secure를 붙이면 브라우저가 쿠키를 버린다.
    const cookies = [formatSessionCookie(joined.session, { secure: listener.secure, port: listener.port })];
    if (joined.pairingSecret !== null) cookies.push(formatPairingCookie(joined.pairingSecret, { secure: listener.secure, port: listener.port }));
    res.writeHead(204, withSecurityHeaders({ "Set-Cookie": cookies }));
    res.end();
    return true;
  }

  interface JoinAccepted {
    readonly session: AccessSession;
    /** 새 페어링이거나 만료 창을 다시 민 기존 페어링. 페어링이 없는 조인에서는 null이다. */
    readonly pairingSecret: string | null;
  }

  interface JoinRejected {
    readonly status: number;
    readonly error: string;
  }

  function pairFromGrant(listener: ListenerIdentity, token: string, device: string | null): JoinAccepted | JoinRejected {
    /**
     * 자격을 소모하기 전에 판정한다. consumeGrant는 성공 여부와 무관하게 토큰을 지우므로,
     * 뒤에서 거절하면 1회용 링크만 태우고 아무도 붙지 못한다.
     */
    const pending = access.peekGrant(token, listener.audience);
    /**
     * 상한에 걸린 조인은 grant를 태우지 않는다 — 자리를 비운 뒤 같은 링크가 아직 통해야 한다.
     * 다만 되살아나는 것은 링크 문자열뿐이다. 셸이 들고 있던 자격은 handoff가 한 번만 넘기므로,
     * 목록에서 그 콘솔을 다시 여는 길로는 돌아올 수 없고 링크를 다시 붙여넣어야 한다.
     */
    if (pending !== null && listener.audience === "remote" && pairedDeviceStore.list("remote").length >= PAIRED_DEVICE_LIMIT) {
      return { status: 409, error: "paired_device_limit" };
    }
    const grant = access.consumeGrant(token, listener.audience);
    if (!grant) return { status: 401, error: "unauthorized" };
    // 루프백은 페어링을 만들지 않는다 — 이 리스너에는 애초에 세션 게이트가 없다.
    if (listener.audience !== "remote") {
      return { session: access.openSession(listener.audience, grant.access, device, null), pairingSecret: null };
    }
    const paired = pairedDeviceStore.pair({ audience: listener.audience, access: grant.access, device });
    if (!paired) return { status: 409, error: "paired_device_limit" };
    // 거절이 끝난 뒤에 자리를 비운다 — 받지도 못할 조인이 앞사람을 내보내서는 안 된다.
    supersedeRemoteSessions(null);
    return {
      session: access.openSession(listener.audience, grant.access, device, paired.device.id),
      pairingSecret: paired.secret,
    };
  }

  function resumePairedDevice(req: http.IncomingMessage, listener: ListenerIdentity, device: string | null): JoinAccepted | JoinRejected {
    const secret = readPairingCookie(req.headers, listener.port);
    const paired = pairedDeviceStore.resolve(secret, listener.audience);
    if (!paired || secret === null) return { status: 401, error: "unauthorized" };
    /**
     * 자기 페어링이 두고 간 접속은 축출이 아니라 자기 자신의 잔상이므로 안내 없이 걷는다 —
     * 창을 다시 여는 것만으로 "다른 기기가 이어받았습니다"를 자기 화면에 띄울 수는 없다.
     */
    supersedeRemoteSessions(paired.id);
    return {
      // 등급은 페어링이 정한다 — 재개가 monitoring을 full로 올릴 수 없어야 한다.
      session: access.openSession(listener.audience, paired.access, device ?? paired.device, paired.id),
      // 받은 비밀값을 그대로 다시 실어 만료 창을 민다. 서버는 해시만 알므로 이 값은 여기서만 나온다.
      pairingSecret: secret,
    };
  }

  /**
   * 원격 접속은 한 번에 하나다. 이 콘솔은 하나의 화면이고 하나의 터미널이므로, 둘이 동시에
   * 붙으면 커튼은 "누가" 몰고 있는지 하나로 말하지 못하고 회수 버튼의 대상도 갈라진다.
   *
   * 그래서 새 조인이 앞선 접속을 대신한다. 거절하지 않는 이유는, 거절이 자기 기기를 되찾는
   * 길까지 막기 때문이다 — 앞의 접속이 유휴로 남아 있거나 셸이 두고 간 잔상일 때 주인은
   * 자기 콘솔 앞에 가서 그 줄을 끊기 전에는 돌아올 수 없었다. 페어링은 이미 주인이 승인한
   * 자격이고, 그 자격을 거둘 자리는 여전히 기기 목록의 회수 버튼이다.
   *
   * 세션을 열기 전에 부른다 — 열고 나서 걷으면 방금 연 접속이 자기 자신에 걸린다.
   * `ownPairingId`가 두고 간 접속은 축출이 아니므로 안내 없이 걷는다.
   */
  function supersedeRemoteSessions(ownPairingId: string | null): void {
    for (const session of access.listSessions("remote")) {
      if (!access.revokeSessionByHandle(session.handle)) continue;
      // 세션이 사라지면 그 세션이 게시한 집 주소도 가리킬 주인이 없다.
      forgetShell(session.handle);
      /**
       * 자기 페어링이 두고 간 접속에는 안내를 보내지 않는다 — 축출이 아니라 자기 자신의
       * 잔상이므로. 건너뛰는 것은 안내뿐이고 스트림은 그 사정과 무관하게 닫힌다.
       */
      const displaced = session.pairingId === null || session.pairingId !== ownPairingId;
      endSessionStreams(session.handle, displaced ? "superseded" : null);
    }
  }

  return { handleAccessJoin };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sanitizeDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : null;
}
