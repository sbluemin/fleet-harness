import type http from "node:http";
import path from "node:path";

import { createDurableJsonStore, type DurableJsonStore } from "@fleet-console/infra";
import { applyAvatarWrite, AVATARS_API_PATH, sanitizeAvatarBook, sanitizeAvatarWrite, type MongleLook } from "@fleet-console/sdk/avatars";
import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

/**
 * 몽글 아바타 책 — 키(`theater:<id>`·`operation:<id>`) → 모습. Console 서버가 유일한 writer 다.
 *
 * 처음 배정(`claim`)은 비어 있는 키만 받아 먼저 닿은 쪽을 남기고, 편집(`set`)은 덮어쓰되 처음 뽑힌 베이스(origin)를 지킨다.
 * 손상된 파일이나 항목은 정제기가 버리고, 버려진 키는 다음 표시 때 새로 뽑힌다 — 아바타는 장식이라 잃어도 일이 멈추지 않는다.
 */

interface AvatarStoreData {
  readonly version: 1;
  readonly avatars: Record<string, MongleLook>;
}

export const AVATARS_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: AVATARS_API_PATH, summary: "Read the stored mongle avatar of each Theater and Operation.", category: "Workspace", gate: "loopback", transport: "http" },
  { method: "PUT", path: AVATARS_API_PATH, summary: "Claim avatars for keys that have none, or set one avatar's base and tone, and a Commodore's special quaker.", category: "Workspace", gate: "origin-write", transport: "http" },
];

function sanitizeAvatarStoreData(value: unknown): AvatarStoreData {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { version: 1, avatars: record.version === 1 ? sanitizeAvatarBook(record.avatars) : {} };
}

export function createAvatarStore(dataDir: string): DurableJsonStore<AvatarStoreData> {
  const filePath = path.join(dataDir, "avatars.json");
  return createDurableJsonStore<AvatarStoreData>({
    filePath,
    lockDir: `${filePath}.lock`,
    sanitize: sanitizeAvatarStoreData,
    sensitivity: "normal",
  });
}

export function createAvatarRouter(deps: {
  readonly store: DurableJsonStore<AvatarStoreData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}) {
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname !== AVATARS_API_PATH) return false;
    if (req.method === "GET") {
      deps.writeJson(res, 200, { avatars: deps.store.load().avatars });
      return true;
    }
    if (req.method !== "PUT") {
      deps.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      deps.writeJson(res, 415, { error: "unsupported_media_type" });
      return true;
    }
    const write = sanitizeAvatarWrite(await deps.readJsonBody<unknown>(req));
    if (!write) {
      deps.writeJson(res, 400, { error: "invalid_avatar_write" });
      return true;
    }
    const saved = deps.store.update((current) => {
      const avatars = applyAvatarWrite(current.avatars, write);
      return avatars ? { version: 1, avatars } : undefined;
    });
    deps.writeJson(res, 200, { avatars: saved.avatars });
    return true;
  };
}
