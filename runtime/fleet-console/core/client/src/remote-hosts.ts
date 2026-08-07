import { useSyncExternalStore } from "react";

import { ApiError } from "./api.js";

/**
 * 이 콘솔에서 건너갈 수 있는 다른 콘솔들. 목록은 서버가 들고 있고 화면은 그것을 그대로 비춘다 —
 * 어느 창에서 호스트를 더하든 스위처와 설정이 같은 것을 본다.
 */
export interface RemoteHost {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly addedAt: number;
  readonly lastOpenedAt: number | null;
}

export interface RemoteHostReach {
  readonly reachable: boolean;
  /** 응답은 왔지만 인증서가 핀과 다르다는 것은 "꺼짐"과 전혀 다른 사실이다. */
  readonly trusted: boolean;
}

const HOSTS_PATH = "/api/v1/remote-hosts";

type Listener = () => void;

const EMPTY: readonly RemoteHost[] = [];
let snapshot: readonly RemoteHost[] = EMPTY;
let loaded = false;
const listeners = new Set<Listener>();

export function useRemoteHosts(): readonly RemoteHost[] {
  return useSyncExternalStore(subscribe, getRemoteHosts, getRemoteHosts);
}

export function getRemoteHosts(): readonly RemoteHost[] {
  return snapshot;
}

export function hasLoadedRemoteHosts(): boolean {
  return loaded;
}

export async function refreshRemoteHosts(signal?: AbortSignal): Promise<readonly RemoteHost[]> {
  const response = await fetch(HOSTS_PATH, { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly hosts?: unknown };
  publish(Array.isArray(payload.hosts) ? payload.hosts.filter(isRemoteHost) : EMPTY);
  return snapshot;
}

/** 링크는 서버가 연다 — 화면은 봉투를 열지 않고 문자열 그대로 넘긴다. */
export async function addRemoteHost(link: string, signal?: AbortSignal): Promise<RemoteHost> {
  const response = await fetch(HOSTS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link: link.trim() }),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly host?: unknown };
  if (!isRemoteHost(payload.host)) throw new ApiError(response.status, "pairing_target_invalid");
  await refreshRemoteHosts();
  return payload.host;
}

export async function renameRemoteHost(id: string, label: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${HOSTS_PATH}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
    signal,
  });
  await assertOk(response);
  await refreshRemoteHosts();
}

export async function forgetRemoteHost(id: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${HOSTS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  // 이미 사라진 호스트를 지운 것은 실패가 아니다 — 사용자가 원한 상태는 이미 참이다.
  if (response.status !== 404) await assertOk(response);
  await refreshRemoteHosts();
}

export async function probeRemoteHost(id: string, signal?: AbortSignal): Promise<RemoteHostReach> {
  const response = await fetch(`${HOSTS_PATH}/${encodeURIComponent(id)}/probes`, { method: "POST", signal });
  await assertOk(response);
  const payload = await response.json() as Partial<RemoteHostReach>;
  return { reachable: payload.reachable === true, trusted: payload.trusted === true };
}

function publish(next: readonly RemoteHost[]): void {
  loaded = true;
  if (next.length === snapshot.length && next.every((host, index) => same(host, snapshot[index]))) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function same(left: RemoteHost, right: RemoteHost | undefined): boolean {
  return right !== undefined && left.id === right.id && left.label === right.label
    && left.origin === right.origin && left.fingerprint === right.fingerprint && left.lastOpenedAt === right.lastOpenedAt;
}

function isRemoteHost(value: unknown): value is RemoteHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.label === "string"
    && typeof entry.origin === "string"
    && typeof entry.hostname === "string"
    && typeof entry.port === "number"
    && typeof entry.fingerprint === "string"
    && typeof entry.addedAt === "number"
    && (entry.lastOpenedAt === null || typeof entry.lastOpenedAt === "number");
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 쓴다.
  }
  throw new ApiError(response.status, message);
}
