import type * as http from "node:http";
import { normalizeFingerprint } from "@fleet-console/protocol/remote";
import { parseAccessLink } from "./access-link.js";
import { probeRemoteIdentity } from "./remote-discovery.js";
import type { createRemoteHostStore, RemoteHostRecord } from "./remote-hosts.js";
import type { ListenerIdentity } from "./auth.js";
const REMOTE_HOSTS_PATH = "/api/v1/remote-hosts";
interface RemoteHostsRouteDeps {
  readonly remoteHostStore: ReturnType<typeof createRemoteHostStore>;
  readonly readListeners: () => readonly ListenerIdentity[];
  readonly listLocalConsoles: () => Promise<readonly unknown[]>;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isRemoteHostWriteAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}
export function createRemoteHostsRoutes(deps: RemoteHostsRouteDeps) {
  const { remoteHostStore, readListeners, listLocalConsoles, isLoopbackListener, isRemoteHostWriteAuthorized, readJsonBody, writeJson, writeNoContent } = deps;
  async function handleRemoteHosts(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    const rest = pathname.slice(REMOTE_HOSTS_PATH.length).replace(/^\//u, "");
    if (rest.length === 0) {
      if (req.method === "GET") {
        if (!isLoopbackListener(req)) {
          writeJson(res, 401, { error: "unauthorized" });
          return true;
        }
        writeJson(res, 200, { hosts: remoteHostStore.list() });
        return true;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!isRemoteHostWriteAuthorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      await addRemoteHost(req, res);
      return true;
    }

    const [id, action] = rest.split("/");
    if (!isRemoteHostWriteAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const host = remoteHostStore.find(decodeHandle(id ?? ""));
    if (!host) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    if (action === "probes" && req.method === "POST") {
      writeJson(res, 200, await describeReachability(host));
      return true;
    }
    if (action === "cookie-binding" && req.method === "POST") {
      await bindCookies(req, res, host);
      return true;
    }
    if (action !== undefined) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    if (req.method === "DELETE") {
      remoteHostStore.forget(host.id);
      writeNoContent(res);
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody<{ readonly label?: unknown }>(req);
      const label = isPlainObject(body) && typeof body.label === "string" ? body.label : "";
      const renamed = remoteHostStore.rename(host.id, label);
      if (!renamed) {
        writeJson(res, 400, { error: "remote_host_label_invalid" });
        return true;
      }
      writeJson(res, 200, { host: renamed });
      return true;
    }
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  /**
   * 링크 없이 갈 수 있는 지름길. 여기 적힌 루프백 주소는 "이 요청이 도착한 리스너와 같은 기계"를
   * 뜻하므로, 원격 리스너에는 절대 내주지 않는다 — 원격에서 받은 127.0.0.1은 다른 기계다.
   */
  async function handleLocalConsoles(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isLoopbackListener(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    writeJson(res, 200, { consoles: await listLocalConsoles() });
    return true;
  }

  async function addRemoteHost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody<{ readonly link?: unknown }>(req);
    if (!isPlainObject(body) || typeof body.link !== "string") {
      writeJson(res, 400, { error: "pairing_target_invalid" });
      return;
    }
    let link;
    try {
      link = parseAccessLink(body.link);
    } catch {
      writeJson(res, 400, { error: "pairing_target_invalid" });
      return;
    }
    // 자기 자신을 목록에 넣으면 스위처가 제자리를 가리킨다.
    if (readListeners().some((entry) => entry.origin === link.origin)) {
      writeJson(res, 409, { error: "remote_host_is_self" });
      return;
    }
    // 자격을 보내기 전에 그 주소가 정말 그 인증서를 내미는지 먼저 확인한다.
    const probe = await probeRemoteIdentity(link.hostname, link.port, link.fingerprint);
    if (probe.state === "unreachable") {
      writeJson(res, 502, { error: "remote_host_unreachable" });
      return;
    }
    if (probe.state === "mismatch") {
      writeJson(res, 409, { error: "remote_host_fingerprint_mismatch" });
      return;
    }
    // 탐침은 6초까지 끌 수 있고, 그 사이 요청자가 사라질 수 있다(창의 취소가 요청을 끊는다).
    // 기억한다는 것은 목록에 남기고 1회용 자격을 예약한다는 뜻이므로, 아무도 받아 가지 않을
    // 짝짓기를 남기지 않는다 — 취소가 진짜로 멈추려면 이 판정이 여기 있어야 한다.
    if (res.writableEnded || res.destroyed) return;
    writeJson(res, 201, { host: remoteHostStore.remember(link) });
  }

  /**
   * Desktop이 이 호스트에 조인한 뒤 알려 주는 사실: 방금 받은 쿠키는 이 신원에 묶였다. 보고가 가리키는 신원이
   * 지금 기록과 다르면(그 사이 새 링크가 지문을 바꿨다면) 받지 않는다 — 늦은 보고가 새 신원을 덮으면 다음 전환에서
   * 옛 쿠키가 새 인증서로 간다.
   */
  async function bindCookies(req: http.IncomingMessage, res: http.ServerResponse, host: RemoteHostRecord): Promise<void> {
    const body = await readJsonBody<{ readonly fingerprint?: unknown; readonly pinGeneration?: unknown }>(req);
    if (!isPlainObject(body) || typeof body.fingerprint !== "string" || typeof body.pinGeneration !== "number" || !Number.isSafeInteger(body.pinGeneration)) {
      writeJson(res, 400, { error: "remote_host_binding_invalid" });
      return;
    }
    const bound = remoteHostStore.bindCookies(host.id, { fingerprint: normalizeFingerprint(body.fingerprint), pinGeneration: body.pinGeneration });
    if (!bound) {
      writeJson(res, 409, { error: "remote_host_binding_stale" });
      return;
    }
    writeNoContent(res);
  }

  async function describeReachability(host: RemoteHostRecord): Promise<{ readonly reachable: boolean; readonly trusted: boolean }> {
    const probe = await probeRemoteIdentity(host.hostname, host.port, host.fingerprint);
    return { reachable: probe.state !== "unreachable", trusted: probe.state === "match" };
  }

  /**
   * Desktop이 창을 그 호스트로 보내기 직전에 필요한 것을 한 번에 가져간다. 1회용 자격은 이
   * 호출로 소진되므로, 링크 하나가 두 창을 열 수는 없다.
   */
  async function handleRemoteHostHandoff(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isRemoteHostWriteAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await readJsonBody<{ readonly origin?: unknown }>(req);
    const origin = isPlainObject(body) && typeof body.origin === "string" ? body.origin : "";
    const handoff = remoteHostStore.takeHandoff(origin);
    if (!handoff) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    writeJson(res, 200, {
      id: handoff.host.id,
      origin: handoff.host.origin,
      hostname: handoff.host.hostname,
      port: handoff.host.port,
      fingerprint: handoff.host.fingerprint,
      pinGeneration: handoff.host.pinGeneration,
      // 쿠키가 묶인 신원. 지금 지문과 다르거나 null이면 Desktop은 옛 쿠키를 지우고 새 자격으로만 조인한다.
      cookieBoundFingerprint: handoff.host.cookieBinding?.fingerprint ?? null,
      token: handoff.token,
    });
    return true;
  }

  return { handleRemoteHosts, handleLocalConsoles, handleRemoteHostHandoff };
}
function decodeHandle(raw: string): string {
  if (raw.includes("/")) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
