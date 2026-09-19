import type * as http from "node:http";
import { encodeAccessLink } from "./access-link.js";
import { listRemoteInterfaces } from "./remote-discovery.js";
import { effectiveRemoteAccessAdvertisedTuple, type createConsoleSettingsStore } from "../../settings/host/settings-domain.js";
import type { createAccessRegistry, ListenerIdentity, AccessClass } from "./auth.js";
import type { createPairedDeviceStore } from "./paired-devices.js";
import type { createRemoteJoinGuard } from "./remote-join-guard.js";
import type { createRemoteIdentityStore } from "./remote-identity.js";
import type { createRemoteEndpointStore } from "./remote-endpoint.js";
import type { ControlReclaimedReason } from "./access-control-contract.js";
interface RemoteAdminDeps {
  readonly access: ReturnType<typeof createAccessRegistry>;
  readonly pairedDeviceStore: ReturnType<typeof createPairedDeviceStore>;
  readonly remoteJoinGuard: ReturnType<typeof createRemoteJoinGuard>;
  readonly remoteIdentityStore: ReturnType<typeof createRemoteIdentityStore>;
  readonly remoteEndpointStore: ReturnType<typeof createRemoteEndpointStore>;
  readonly consoleSettingsStore: ReturnType<typeof createConsoleSettingsStore>;
  readonly readListenerState: () => { readonly listeners: readonly ListenerIdentity[]; readonly remoteFingerprint: string | null; readonly remoteLastError: string | null };
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isAccessAdminAuthorized: (req: http.IncomingMessage) => boolean;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly withSecurityHeaders: (extra: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  readonly broadcastControlChanged: (resend?: boolean) => void;
  readonly forgetShell: (handle: string) => void;
  readonly endSessionStreams: (handle: string, reason: ControlReclaimedReason | null) => void;
  readonly reconcileRemoteIdentity: () => Promise<void>;
  readonly consoleLabel: () => string;
}
export function createRemoteAdminRoutes(deps: RemoteAdminDeps) {
  const { access, pairedDeviceStore, remoteJoinGuard, remoteIdentityStore, remoteEndpointStore, consoleSettingsStore, readListenerState, isLoopbackListener, isAccessAdminAuthorized, writeJson, withSecurityHeaders, broadcastControlChanged, forgetShell, endSessionStreams, reconcileRemoteIdentity, consoleLabel } = deps;
  function handleRemoteAccessStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    /**
     * 읽기는 루프백이라는 사실만 요구한다 — 형제인 remote-hosts GET과 같은 선례다. Origin까지
     * 요구하면 브라우저가 아닌 로컬 소비자(Desktop·진단 도구)가 함께 막힌다.
     *
     * 원격을 막는 것이 요점이다. 이 응답에는 인증서 지문, 열린 세션의 기기 이름, 미사용 링크,
     * 그리고 이 기계가 가진 모든 주소가 실린다 — 초대받은 손님이 볼 목록이 아니다.
     */
    if (!isLoopbackListener(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const remote = readListenerState().listeners.find((entry) => entry.audience === "remote");
    const sessions = access.listSessions("remote");
    writeJson(res, 200, {
      listener: {
        listening: remote !== undefined && readListenerState().remoteFingerprint !== null,
        origin: remote?.origin ?? null,
        lastError: readListenerState().remoteLastError,
      },
      publicReachability: "unverified",
      // 거절이 일어나고 있다는 사실 자체가 "지금 열어둘 만한가"의 판단 재료다.
      rejectedJoins: remoteJoinGuard.stats(),
      fingerprint: readListenerState().remoteFingerprint,
      // 발급 사실만 나간다 — 목록을 보는 것으로는 어떤 링크도 다시 쓸 수 없다.
      links: access.listGrants("remote"),
      /**
       * 화면이 보는 단위는 페어링이다. 접속은 그 페어링의 현재 상태로 접혀 들어간다 — 끊어도
       * 사라지지 않는 줄과 끊으면 사라지는 줄이 한 표에 섞이면 무엇을 회수하는지 알 수 없다.
       */
      devices: pairedDeviceStore.list("remote").map((device) => {
        const open = sessions.find((session) => session.pairingId === device.id) ?? null;
        return {
          id: device.id,
          device: device.device,
          access: device.access,
          pairedAt: device.pairedAt,
          lastSeenAt: Math.max(device.lastSeenAt, open?.lastSeenAt ?? 0),
          sessionHandle: open?.handle ?? null,
        };
      }),
      interfaces: listRemoteInterfaces(),
    });
  }

  function handleAccessLinkRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!access.revokeGrant(decodeHandle(rawId))) {
      writeJson(res, 404, { error: "link_not_found" });
      return;
    }
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 지금 붙어 있는 접속 하나를 끊는다. 페어링은 건드리지 않는다 — 제어를 되찾는 일과 그 기기를
   * 손님 목록에서 지우는 일은 다른 결정이고, 다른 버튼이다. 끊긴 기기는 자기 페어링 쿠키로
   * 다시 붙어 제어를 되가져올 수 있고, 이 기계의 화면은 그때 다시 커튼을 올린다.
   */
  function handleAccessSessionRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawHandle: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const handle = decodeHandle(rawHandle);
    if (!access.revokeSessionByHandle(handle)) {
      // 이미 만료된 보유자를 향한 회수다. 404로만 끝내면 화면은 유령 보유자를 계속 띄운 채
      // 남으므로, 사라졌다는 사실을 여기서 다시 알려 스스로 정리되게 한다.
      broadcastControlChanged(true);
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    // 세션이 사라지면 그 세션이 게시한 집 주소도 가리킬 주인이 없다. 남겨 두면 handle이
    // 재사용되지 않는 이상 되살아나지는 않지만, 오래 뜬 서버에서 계속 쌓이기만 한다.
    forgetShell(handle);
    // 순서가 있다: 끊긴 쪽이 먼저 자기 안내를 받고, 그 다음 이 기계의 화면이 커튼을 걷는다.
    endSessionStreams(handle, "reclaimed");
    broadcastControlChanged();
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 페어링 하나를 영구히 거둔다. 접속을 끊는 것과 달리 이쪽은 되돌아올 길까지 없앤다 —
   * 그 기기는 새 액세스 링크를 받기 전에는 다시 붙지 못한다.
   */
  function handlePairedDeviceRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const removed = pairedDeviceStore.revoke(decodeHandle(rawId));
    if (!removed) {
      writeJson(res, 404, { error: "paired_device_not_found" });
      return;
    }
    // 자격을 거두면서 그 자격으로 열려 있던 접속을 남겨 두면, 회수는 다음 요청까지만 참이다.
    const closed = access.listSessions("remote").filter((session) => session.pairingId === removed.id);
    access.revokeSessionsByPairing(removed.id);
    for (const session of closed) {
      forgetShell(session.handle);
      endSessionStreams(session.handle, "reclaimed");
    }
    broadcastControlChanged();
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 신원 갱신. 새 인증서를 발급하고 리스너를 그 인증서로 다시 연다. 옛 지문을 실은 링크와
   * 그 지문으로 고정한 Desktop 핀은 이 순간 전부 무효가 되므로, 미사용 링크와 열린 세션도
   * 함께 걷어낸다 — 남겨 두면 붙을 수 없는 자격이 목록에 남는다.
   *
   * 페어링도 같이 간다. 페어링은 회수 전까지 사는 자격이지만, 그 기기가 이 콘솔을 알아보는
   * 근거였던 지문이 방금 바뀌었다 — 붙을 수 없는 손님을 목록에 남기는 것은 사실이 아니다.
   *
   * 공표한 포트도 여기서 놓는다. 어차피 아무도 이 주소로 돌아오지 못하는 순간이므로, 포트를
   * 붙들고 있을 이유가 없다 — 그리고 이것이 남이 쥔 포트에서 빠져나오는 유일한 길이다.
   * 이 버튼은 이미 "모두 새 링크를 받아야 한다"는 뜻이고, 새 링크는 새 주소를 싣고 나간다.
   */
  async function handleRemoteIdentityRotation(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    /**
     * 살아 있는 리스너가 없어도 설정이 켜져 있으면 갱신은 성립해야 한다. 리스너가 열리지
     * 못한 상태야말로 이 버튼이 가장 필요한 자리다 — 공표한 포트를 남이 쥐고 있을 때 그것을
     * 놓는 유일한 길이 여기이고, 리스너를 조건으로 걸면 그 길이 자기 자신에 막힌다.
     */
    const configured = consoleSettingsStore.load().general?.remoteAccess;
    const advertisedHost = readListenerState().listeners.find((entry) => entry.audience === "remote")?.host
      ?? (configured?.enabled === true ? effectiveRemoteAccessAdvertisedTuple(configured).host : null);
    if (!advertisedHost) {
      writeJson(res, 409, { error: "remote_access_disabled" });
      return true;
    }
    await remoteIdentityStore.rotate(advertisedHost);
    access.revokeGrants("remote");
    pairedDeviceStore.revokeAll("remote");
    remoteEndpointStore.forget();
    await reconcileRemoteIdentity();
    if (readListenerState().remoteFingerprint === null) {
      writeJson(res, 500, { error: readListenerState().remoteLastError ?? "remote_listener_failed" });
      return true;
    }
    writeJson(res, 200, { fingerprint: readListenerState().remoteFingerprint });
    return true;
  }


  /**
   * 원격 액세스 링크. 주소·자격·신원·이름을 하나의 봉투에 담아 `fleet://join?code=`로 실어
   * 나른다. 봉투는 인코딩이지 암호가 아니다 — 붙여넣은 문자열을 눈으로 읽어서는 사설 주소가
   * 보이지 않지만, 그 문자열을 가진 쪽은 언제든 풀어 볼 수 있다. 그러므로 이 링크는 가려진
   * 주소가 아니라 자격 그 자체로 다루고, 신뢰하는 경로로만 건넨다. 이 스킴을 여는 주체는
   * Fleet Desktop 하나뿐이다.
   */
  function handleAccessLinkIssue(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const requestedAccess = readAccessClass(req);
    if (requestedAccess === null) {
      writeJson(res, 400, { error: "invalid_access_class" });
      return;
    }
    const remote = readListenerState().listeners.find((entry) => entry.audience === "remote");
    const fingerprint = readListenerState().remoteFingerprint;
    if (!remote || !fingerprint) {
      writeJson(res, 409, { error: "remote_access_disabled" });
      return;
    }
    const grant = access.issueGrant("remote", requestedAccess);
    const link = encodeAccessLink({ endpoint: remote.origin, token: grant.token, fingerprint, label: consoleLabel() });
    writeJson(res, 201, { id: grant.id, link, access: grant.access, expiresAt: grant.expiresAt, fingerprint: readListenerState().remoteFingerprint });
  }

  return { handleRemoteAccessStatus, handleAccessLinkRevoke, handleAccessSessionRevoke, handlePairedDeviceRevoke, handleRemoteIdentityRotation, handleAccessLinkIssue };
}
function decodeHandle(raw: string): string {
  if (raw.includes("/")) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
function readAccessClass(req: http.IncomingMessage): AccessClass | null {
  const requested = new URL(req.url ?? "/", "http://localhost").searchParams.get("access");
  if (requested === null || requested === "full") return "full";
  return requested === "monitoring" ? "monitoring" : null;
}
function readUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}
