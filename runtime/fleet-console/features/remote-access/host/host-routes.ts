import type * as http from "node:http";
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
      origin: handoff.host.origin,
      hostname: handoff.host.hostname,
      port: handoff.host.port,
      fingerprint: handoff.host.fingerprint,
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
