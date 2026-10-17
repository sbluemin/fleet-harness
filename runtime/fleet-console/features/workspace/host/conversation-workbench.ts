import type http from "node:http";
import path from "node:path";

import { createDurableJsonStore, type DurableJsonStore } from "@fleet-console/infra";
import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

import {
  applyWorkbenchWrite,
  CONVERSATION_WORKBENCH_API_PATH,
  sanitizeWorkbenchStoreData,
  sanitizeWorkbenchWrite,
  type WorkbenchStoreData,
} from "../shared/conversation-workbench.js";

/**
 * 대화별 도구 작업대 배치 — 대화 키(`operation:<id>` 등) → 열린 도구·순서·비율·펼침. Console 서버가 유일한 writer 다.
 *
 * 배치는 화면 배치라 잃어도 일이 멈추지 않는다 — 손상된 파일이나 항목은 정제기가 버리고 그 대화는 빈 작업대로 다시 선다.
 * 절대 경로처럼 보이는 params 는 정제기가 걷으므로 이 파일과 응답에 원시 경로가 남지 않는다.
 */

export const CONVERSATION_WORKBENCH_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: CONVERSATION_WORKBENCH_API_PATH, summary: "Read the saved tool split layout of each conversation.", category: "Workspace", gate: "loopback", transport: "http" },
  { method: "PUT", path: CONVERSATION_WORKBENCH_API_PATH, summary: "Save or clear one conversation's tool split layout.", category: "Workspace", gate: "origin-write", transport: "http" },
];

export function createConversationWorkbenchStore(dataDir: string): DurableJsonStore<WorkbenchStoreData> {
  const filePath = path.join(dataDir, "conversation-workbench.json");
  return createDurableJsonStore<WorkbenchStoreData>({
    filePath,
    lockDir: `${filePath}.lock`,
    sanitize: sanitizeWorkbenchStoreData,
    sensitivity: "normal",
  });
}

export function createConversationWorkbenchRouter(deps: {
  readonly store: DurableJsonStore<WorkbenchStoreData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname !== CONVERSATION_WORKBENCH_API_PATH) return false;
    if (req.method === "GET") {
      deps.writeJson(res, 200, { layouts: deps.store.load().layouts });
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
    const write = sanitizeWorkbenchWrite(await deps.readJsonBody<unknown>(req));
    if (!write) {
      deps.writeJson(res, 400, { error: "invalid_workbench_write" });
      return true;
    }
    deps.store.update((current) => ({ version: 1, layouts: applyWorkbenchWrite(current.layouts, write, now()) }));
    // 응답은 짧게 — 쓴 쪽은 자기 상태를 이미 들고 있다.
    deps.writeJson(res, 200, { ok: true });
    return true;
  };
}
