import { realpathSync, statSync } from "node:fs";
import type http from "node:http";
import path from "node:path";

import { createDurableJsonStore, type DurableJsonStore } from "@fleet-console/infra";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { ConversationWorkLocation } from "../shared/pane.js";

import {
  applyWorkbenchWrite,
  CONVERSATION_WORKBENCH_API_PATH,
  sanitizeWorkbenchStoreData,
  sanitizeWorkbenchWrite,
  type WorkbenchStoreData,
} from "../shared/conversation-workbench.js";

/**
 * 대화별 도구 작업대 배치 — 대화 키(`objectiveRecord:<id>` 등) → 열린 도구·순서·비율·펼침. Console 서버가 유일한 writer 다.
 *
 * 배치는 화면 배치라 잃어도 일이 멈추지 않는다 — 손상된 파일이나 항목은 정제기가 버리고 그 대화는 빈 작업대로 다시 선다.
 * 절대 경로처럼 보이는 params 는 정제기가 걷으므로 이 파일과 응답에 원시 경로가 남지 않는다.
 */

export const CONVERSATION_WORKBENCH_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: CONVERSATION_WORKBENCH_API_PATH, summary: "Read the saved tool split layout of each conversation.", category: "Workspace", gate: "loopback", transport: "http" },
  { method: "PUT", path: CONVERSATION_WORKBENCH_API_PATH, summary: "Save or clear one conversation's tool split layout.", category: "Workspace", gate: "origin-write", transport: "http" },
  { method: "GET", path: `${CONVERSATION_WORKBENCH_API_PATH}/location`, summary: "Resolve an Objective conversation's work location as a Theater-relative coordinate.", category: "Workspace", gate: "loopback", transport: "http" },
];

/**
 * 대화의 작업 위치 — 그 Objective 의 작업 폴더(payload cwd)를 Theater 루트 기준 상대 좌표로 접는다. 절대 경로는 밖으로 나가지 않는다.
 * 작업 폴더가 없거나, 사라졌거나, Theater 밖이면 Theater 루트다(사람이 다시 고르지 않는다 — 가장 안전한 기본값).
 */
export function resolveConversationWorkLocation(input: {
  readonly theaterId: string;
  readonly theaterRoot: string;
  readonly theaterLabel: string;
  readonly cwd: string | null;
}): ConversationWorkLocation {
  const root: ConversationWorkLocation = { theaterId: input.theaterId, relative: "", kind: "root", label: input.theaterLabel };
  if (input.cwd === null || input.cwd === "" || !path.isAbsolute(input.cwd)) return root;
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync.native(input.theaterRoot);
    real = realpathSync.native(input.cwd);
  } catch {
    return root;
  }
  const relative = path.relative(realRoot, real);
  if (relative === "") return root;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return root;
  let kind: ConversationWorkLocation["kind"] = "directory";
  try {
    // git 워크트리의 루트에는 `.git` 이 디렉터리가 아니라 파일(gitdir 포인터)로 있다.
    if (statSync(path.join(real, ".git")).isFile()) kind = "worktree";
  } catch {
    kind = "directory";
  }
  return { theaterId: input.theaterId, relative: relative.split(path.sep).join("/"), kind, label: path.basename(real) };
}

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
  /**
   * Objective(또는 구성원 세션) id → 그 대화의 작업 위치. 모르는 id 면 null. `folder`(Theater 상대)를 주면 세션이 옮겨 간 그
   * 폴더를 분류한다 — 브라우저가 이미 받은 「지금 어디」 투영이다. 루트 밖으로 오르거나 실제로 밖을 가리키면 루트다.
   */
  readonly locate?: (objectiveId: string, folder: string | null) => ConversationWorkLocation | null;
}) {
  const now = deps.now ?? Date.now;
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname === `${CONVERSATION_WORKBENCH_API_PATH}/location`) {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const query = new URL(req.url ?? "", "http://localhost").searchParams;
      const objectiveId = query.get("objectiveId");
      const folder = query.get("folder");
      const location = objectiveId && deps.locate ? deps.locate(objectiveId, folder) : null;
      if (location === null) deps.writeJson(res, 404, { error: "objectiveRecord_not_found" });
      else deps.writeJson(res, 200, { location });
      return true;
    }
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
