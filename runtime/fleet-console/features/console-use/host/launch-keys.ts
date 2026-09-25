import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureSafeDirectory } from "@fleet-console/infra";
import type { OperationNode } from "@fleet-console/sdk/operations";

/**
 * 멱등 기동 키 원장 — 플러그인이 붙인 키 하나에 Operation 이 많아야 하나 생기고, 사람이 지운 키는 다시 생기지 않게 한다.
 *
 * 키는 기동 때 Operation payload(`launchKey`)에 실려 Operation 과 같은 영속 저장에 원자적으로 남는다. 그래서 살아 있는 키와
 * 삭제 유예 중인 키는 Operation·tombstone 에서 읽고, 이 원장은 세 가지를 기록한다 — 예약(수락한 키의 자리), 생성(그 키로
 * Operation 이 섰다), purge(유예가 끝나 흔적이 사라진 키). purge 기록은 tombstone 을 지우는 저장보다 **먼저** 쓴다(선기록).
 * 그래서 원장에 없고 Operation·tombstone 에도 없는 키는 「영속된 적 없음」으로 확정된다. 생성 기록이 있는데 Operation 이 어디에도
 * 없으면(호스트 상태가 비워진 경우 등) 사라진 것으로 보고 purged 로 답한다 — 다시 만들지 않는다.
 *
 * 수락한 키는 만료하지 않는다 — 원장을 비우면 absent 가 「만든 적 없음」이라는 계약이 깨진다. 대신 소유자별 용량 상한을
 * 두고, 새 키를 받기 전에만 검사한다. 이미 수락한 키의 purge 기록은 상한과 무관하게 쓴다.
 */

export type LaunchKeyState = "absent" | "reserved" | "live" | "deleting" | "purged";

export interface LaunchKeyMarker {
  readonly owner: string;
  readonly key: string;
}

/**
 * 소유자별 상한. 한 항목은 JSON 으로 약 200바이트(소유자·UUID 키·Theater·Operation id·시각, 실측 203B)라 상한에서 파일은 약
 * 400KB 이고, 새 키 예약·생성·purge 때만 다시 쓴다(Operation 상태 저장과 별개 파일이라 평소 저장 비용에 더해지지 않는다).
 */
export const LAUNCH_KEY_LIMIT = 2000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface LedgerEntry {
  readonly owner: string;
  readonly key: string;
  readonly theaterId: string;
  readonly state: "reserved" | "created" | "purged";
  readonly operationId?: string;
  readonly at: number;
}
interface LedgerFile { readonly version: 1; readonly entries: readonly LedgerEntry[] }

export class LaunchKeyError extends Error {
  constructor(readonly code: "launch_key_capacity" | "launch_key_conflict" | "launch_key_invalid" | "storage_unavailable") { super(code); }
}

export interface LaunchKeyLedgerDeps {
  readonly directory: string;
  readonly operations: () => readonly OperationNode[];
  /** 삭제 유예 중인 Operation — tombstone 이 들고 있는 노드. */
  readonly tombstoned: () => readonly OperationNode[];
  readonly limit?: number;
  readonly now?: () => number;
}

export interface LaunchKeyLedger {
  /** 키의 지금 상태. 다른 Theater 에 선 키는 conflict 로 거절한다(그 Operation 을 드러내지 않는다). */
  state(owner: string, theaterId: string, key: string): { readonly state: LaunchKeyState; readonly operationId?: string };
  /** 키들을 한꺼번에 예약한다(전부 또는 전무). 이미 수락한 키는 다시 세지 않는다. */
  reserve(owner: string, theaterId: string, keys: readonly string[]): void;
  usage(owner: string): { readonly used: number; readonly limit: number };
  /** 키로 Operation 이 섰다 — 뒤에 그 Operation 이 흔적 없이 사라져도 absent 로 답하지 않게 남긴다. 실패하면 예약으로 남는다. */
  recordCreated(owner: string, key: string, operationId: string): void;
  /** tombstone 을 지우기 전에 부른다 — 그 노드들의 키를 purged 로 선기록한다. 실패하면 던지고 호출자는 purge 를 미룬다. */
  recordPurged(nodes: readonly OperationNode[]): void;
}

/** payload 의 기동 키 표식. 모양이 어긋나면 없다. */
export function readLaunchKeyMarker(payload: Record<string, unknown> | undefined): LaunchKeyMarker | null {
  const value = payload?.launchKey;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.owner === "string" && typeof record.key === "string" ? { owner: record.owner, key: record.key } : null;
}

export function assertLaunchKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new LaunchKeyError("launch_key_invalid");
}

export function createLaunchKeyLedger(deps: LaunchKeyLedgerDeps): LaunchKeyLedger {
  const now = deps.now ?? Date.now;
  const limit = deps.limit ?? LAUNCH_KEY_LIMIT;
  const file = path.join(deps.directory, "launch-keys.json");
  const id = (owner: string, key: string) => `${owner}\u0000${key}`;
  let entries = new Map<string, LedgerEntry>();
  // 읽지 못한 원장으로는 absent 를 말할 수 없다 — 깨진 파일이면 모든 판정을 거절한다(덮어쓰지 않는다).
  let broken = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LedgerFile>;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error("invalid_ledger");
    for (const entry of raw.entries) {
      if (!entry || typeof entry.owner !== "string" || typeof entry.key !== "string" || typeof entry.theaterId !== "string"
        || (entry.state !== "reserved" && entry.state !== "created" && entry.state !== "purged") || !Number.isFinite(entry.at)) throw new Error("invalid_ledger");
      entries.set(id(entry.owner, entry.key), entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") broken = true;
  }

  const persist = (next: Map<string, LedgerEntry>) => {
    if (broken) throw new LaunchKeyError("storage_unavailable");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      ensureSafeDirectory(deps.directory);
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...next.values()] } satisfies LedgerFile), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
      throw new LaunchKeyError("storage_unavailable");
    }
    entries = next;
  };
  const find = (nodes: readonly OperationNode[], owner: string, key: string) => nodes.find((node) => {
    const marker = readLaunchKeyMarker(node.payload);
    return marker?.owner === owner && marker.key === key;
  });
  const owned = (owner: string) => [...entries.values()].filter((entry) => entry.owner === owner).length;

  return {
    state(owner, theaterId, key) {
      assertLaunchKey(key);
      if (broken) throw new LaunchKeyError("storage_unavailable");
      const guard = (actual: string) => { if (actual !== theaterId) throw new LaunchKeyError("launch_key_conflict"); };
      const live = find(deps.operations(), owner, key);
      if (live) { guard(live.theaterId); return { state: "live", operationId: live.id }; }
      const deleting = find(deps.tombstoned(), owner, key);
      if (deleting) { guard(deleting.theaterId); return { state: "deleting", operationId: deleting.id }; }
      const entry = entries.get(id(owner, key));
      if (!entry) return { state: "absent" };
      guard(entry.theaterId);
      return entry.state === "reserved" ? { state: "reserved" } : { state: "purged", ...(entry.operationId ? { operationId: entry.operationId } : {}) };
    },

    reserve(owner, theaterId, keys) {
      for (const key of keys) assertLaunchKey(key);
      if (broken) throw new LaunchKeyError("storage_unavailable");
      const fresh = new Map<string, LedgerEntry>();
      for (const key of new Set(keys)) {
        const existing = entries.get(id(owner, key));
        if (existing) { if (existing.theaterId !== theaterId) throw new LaunchKeyError("launch_key_conflict"); continue; }
        const live = find(deps.operations(), owner, key) ?? find(deps.tombstoned(), owner, key);
        if (live && live.theaterId !== theaterId) throw new LaunchKeyError("launch_key_conflict");
        fresh.set(id(owner, key), { owner, key, theaterId, state: "reserved", at: now() });
      }
      if (fresh.size === 0) return;
      if (owned(owner) + fresh.size > limit) throw new LaunchKeyError("launch_key_capacity");
      persist(new Map([...entries, ...fresh]));
    },

    usage: (owner) => ({ used: owned(owner), limit }),

    recordCreated(owner, key, operationId) {
      const current = entries.get(id(owner, key));
      if (!current || current.state !== "reserved") return;
      persist(new Map([...entries, [id(owner, key), { ...current, state: "created", operationId }]]));
    },

    recordPurged(nodes) {
      const next = new Map(entries);
      let changed = false;
      for (const node of nodes) {
        const marker = readLaunchKeyMarker(node.payload);
        if (!marker) continue;
        const current = next.get(id(marker.owner, marker.key));
        if (current?.state === "purged" && current.operationId === node.id) continue;
        // 상한과 무관하다 — 이미 수락해 Operation 까지 선 키의 삭제 기록은 막지 않는다.
        next.set(id(marker.owner, marker.key), { owner: marker.owner, key: marker.key, theaterId: node.theaterId, state: "purged", operationId: node.id, at: now() });
        changed = true;
      }
      if (changed) persist(next);
    },
  };
}
