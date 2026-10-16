import { DESKTOP_HOST_TRANSPORT_EVENT, DESKTOP_HOST_TRANSPORT_EVENTS_PATH, DESKTOP_HOST_TRANSPORT_PATH, DESKTOP_HOST_TRANSPORT_RELAY_PATH, isDesktopHostSnapshot, type DesktopHostCommand, type DesktopHostRelay } from "@fleet-console/protocol/desktop";
import { normalizeFingerprint } from "@fleet-console/protocol/remote";

import { createDesktopEventStream } from "./desktop-event-stream.js";

export interface HostPartitionCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
}

export interface HostPartition {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  readCookies(url: string): Promise<readonly HostPartitionCookie[]>;
  writeCookie(cookie: HostPartitionCookie & { readonly url: string }): Promise<void>;
  pin(hostname: string, fingerprint: string): void;
  clear(): void;
}

export interface HostTransportExecutorDeps {
  readonly confirmIdentity: (hostname: string, port: number, fingerprint: string) => Promise<void>;
  readonly openPartition: (hostKey: string) => HostPartition;
  readonly readWindowCookies: (url: string) => Promise<readonly HostPartitionCookie[]>;
  readonly writeWindowCookie: (cookie: HostPartitionCookie & { readonly url: string }) => Promise<void>;
}

const SESSION_RESPONSE = "/api/v1/sessions";

export function createHostTransportExecutor(deps: HostTransportExecutorDeps): { execute(command: DesktopHostCommand): Promise<DesktopHostRelay> } {
  const partitions = new Map<string, { readonly origin: string; readonly fingerprint: string; readonly partition: HostPartition }>();

  const partitionFor = async (command: DesktopHostCommand): Promise<{ origin: string; partition: HostPartition } | DesktopHostRelay> => {
    try {
      await deps.confirmIdentity(command.target.hostname, command.target.port, command.target.fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { id: command.id, error: message === "remote_link_fingerprint_mismatch" ? "remote_host_fingerprint_mismatch" : "remote_host_unreachable" };
    }
    const host = command.target.hostname.includes(":") ? `[${command.target.hostname}]` : command.target.hostname;
    const origin = new URL(`https://${host}:${command.target.port}`).origin;
    const existing = partitions.get(command.hostKey);
    if (existing && (existing.origin !== origin || existing.fingerprint !== command.target.fingerprint)) {
      existing.partition.clear();
      partitions.delete(command.hostKey);
    }
    const partition = partitions.get(command.hostKey)?.partition ?? deps.openPartition(command.hostKey);
    partition.pin(command.target.hostname, normalizeFingerprint(command.target.fingerprint));
    partitions.set(command.hostKey, { origin, fingerprint: normalizeFingerprint(command.target.fingerprint), partition });
    await copyPairingCookie(origin, command.target.port, partition);
    return { origin, partition };
  };

  const copyPairingCookie = async (origin: string, port: number, partition: HostPartition): Promise<void> => {
    const name = `fleet_console_pairing_${port}`;
    const cookies = await deps.readWindowCookies(origin);
    const pairing = cookies.find((cookie) => cookie.name === name);
    if (!pairing) return;
    await partition.writeCookie({ ...pairing, url: origin });
  };

  const rememberPairing = async (origin: string, port: number, response: Response, partition: HostPartition): Promise<void> => {
    const name = `fleet_console_pairing_${port}`;
    const renewed = (await partition.readCookies(origin)).find((cookie) => cookie.name === name);
    if (!renewed) return;
    await deps.writeWindowCookie({ ...renewed, url: origin, path: "/", secure: true, httpOnly: true });
    void response;
  };

  return {
    async execute(command) {
      const opened = await partitionFor(command);
      if (!("partition" in opened)) return opened;
      if (command.op === "presence") return performPresence(command, opened.origin, opened.partition);
      if (command.op === "http" || command.op === "bytes") return performHttp(command, opened.origin, opened.partition);
      return { id: command.id, error: "remote_host_unavailable" };
    },
  };

  async function performPresence(command: DesktopHostCommand, origin: string, partition: HostPartition): Promise<DesktopHostRelay> {
    const intent = command.params.intent;
    if (intent !== "observe" && intent !== "activate" && intent !== "release") return { id: command.id, error: "invalid_host_request" };
    const response = await partition.fetch(`${origin}${SESSION_RESPONSE}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    await rememberPairing(origin, command.target.port, response, partition);
    if (response.status === 404 || response.status === 405) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401) return { id: command.id, error: "remote_host_not_paired" };
    if (response.status === 403) return { id: command.id, error: "observer_only" };
    if (!response.ok || !isSessionCapability(body)) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    return { id: command.id, capability: "supported", mode: body.mode, access: body.access };
  }

  async function performHttp(command: DesktopHostCommand, origin: string, partition: HostPartition): Promise<DesktopHostRelay> {
    const path = typeof command.params.path === "string" && command.params.path.startsWith("/") ? command.params.path : null;
    const method = command.params.method === "GET" || command.params.method === "HEAD" || command.params.method === "POST" ? command.params.method : null;
    if (!path || !method || path.startsWith("//") || path.includes("://")) return { id: command.id, error: "route_denied" };
    const hasJson = Object.prototype.hasOwnProperty.call(command.params, "json");
    const response = await partition.fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      headers: hasJson ? { "content-type": "application/json" } : undefined,
      body: hasJson ? JSON.stringify(command.params.json) : undefined,
    });
    await rememberPairing(origin, command.target.port, response, partition);
    if (response.status === 204 || response.status === 205 || response.status === 304) return { id: command.id, status: response.status, contentType: null };
    const type = response.headers.get("content-type") ?? "";
    if (command.op === "bytes") {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { id: command.id, status: response.status, contentType: safeByteType(type), dataBase64: bytes.toString("base64") };
    }
    if (!type.includes("json")) return { id: command.id, status: response.status, contentType: null };
    try {
      return { id: command.id, status: response.status, contentType: "application/json", json: await response.json() };
    } catch {
      return { id: command.id, status: response.status, contentType: null };
    }
  }
}

function isSessionCapability(value: unknown): value is { capability: "host-session"; mode: "off" | "observer" | "controller"; access: "full" | "monitoring" | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.capability !== "host-session") return false;
  if (body.mode !== "off" && body.mode !== "observer" && body.mode !== "controller") return false;
  if (body.access !== null && body.access !== "full" && body.access !== "monitoring") return false;
  if (body.mode === "controller" && body.access !== "full") return false;
  if (body.mode === "off" && body.access !== null) return false;
  return true;
}

function safeByteType(value: string): string {
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp" ? type : "application/octet-stream";
}

export function createDesktopHostTransport(deps: HostTransportExecutorDeps & { readonly fetch: typeof fetch; readonly log?: (message: string) => void }): { start(origin: string): Promise<void>; stop(): void } {
  const executor = createHostTransportExecutor(deps);
  const running = new Set<number>();
  let activeOrigin: string | null = null;
  const postRelay = async (relay: DesktopHostRelay): Promise<void> => {
    const origin = activeOrigin;
    if (!origin) return;
    const response = await deps.fetch(`${origin}${DESKTOP_HOST_TRANSPORT_RELAY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify(relay),
    });
    if (!response.ok) deps.log?.(`host transport relay rejected status=${response.status}`);
  };
  const stream = createDesktopEventStream({
    snapshotPath: DESKTOP_HOST_TRANSPORT_PATH,
    eventsPath: DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
    eventName: DESKTOP_HOST_TRANSPORT_EVENT,
    parseSnapshot: (value) => isDesktopHostSnapshot(value) ? value : null,
    maxFrameChars: 2_000_000,
    normalizeOrigin: (origin) => new URL(origin).origin,
    fetch: deps.fetch,
    apply: (snapshot) => {
      for (const command of snapshot.commands) {
        if (running.has(command.id)) continue;
        running.add(command.id);
        void executor.execute(command).then((relay) => postRelay(relay)).catch((error: unknown) => {
          deps.log?.(`host transport failed: ${error instanceof Error ? error.message : "unknown"}`);
          return postRelay({ id: command.id, error: "remote_host_unavailable" });
        });
      }
    },
  });
  return {
    start(origin) {
      activeOrigin = new URL(origin).origin;
      return stream.start(activeOrigin);
    },
    stop() {
      activeOrigin = null;
      running.clear();
      stream.stop();
    },
  };
}
