import type * as http from "node:http";
import { listTheaterFolders, TheaterFolderListError, type createFolderGrantStore } from "./theaters/theater-domain.js";
import { DeferredDeletionError, type createDeferredDeletionCoordinator } from "./deferred-deletion.js";
import { ObjectiveArchiveError } from "./objective-archive-storage.js";
import type { ConsoleTheaterFolderListResponse } from "../../../core/host/transport/console-contract-types.js";

type TheaterFolderListBody = { readonly path?: unknown };
type TheaterFolderGrantBody = { readonly path?: unknown };

interface WorkspaceRouteDeps {
  readonly folderGrants: ReturnType<typeof createFolderGrantStore>;
  readonly deletionCoordinator: Pick<ReturnType<typeof createDeferredDeletionCoordinator>, "restore">;
  readonly isTerminalAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;

}

export function createWorkspaceRoutes(deps: WorkspaceRouteDeps) {
  const { folderGrants, deletionCoordinator, isTerminalAuthorized, readJsonBody, writeJson } = deps;
  async function handleTheaterFoldersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TheaterFolderListBody>(req);
    if (!isPlainObject(body) || (body.path !== undefined && body.path !== null && typeof body.path !== "string")) {
      writeJson(res, 400, { error: "invalid_path" });
      return;
    }
    try {
      const payload: ConsoleTheaterFolderListResponse = await listTheaterFolders(body.path === undefined ? null : body.path);
      writeJson(res, 200, payload);
    } catch (error) {
      if (error instanceof TheaterFolderListError) {
        writeJson(res, theaterFolderListStatus(error), { error: error.code });
        return;
      }
      throw error;
    }
  }

  async function handleTheaterFolderGrants(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TheaterFolderGrantBody>(req);
    if (!isPlainObject(body) || typeof body.path !== "string") {
      writeJson(res, 400, { error: "invalid_folder" });
      return;
    }
    try {
      writeJson(res, 200, { folderGrantId: folderGrants.issue(body.path) });
    } catch {
      writeJson(res, 400, { error: "invalid_folder" });
    }
  }

  async function handleDeferredDeletionRestore(req: http.IncomingMessage, res: http.ServerResponse, deletionId: string): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const restored = await deletionCoordinator.restore(deletionId);
      writeJson(res, 200, restored);
    } catch (error) {
      if (error instanceof DeferredDeletionError || error instanceof ObjectiveArchiveError) {
        writeJson(res, error.status, { error: error.message });
        return;
      }
      throw error;
    }
  }

  return { handleTheaterFoldersList, handleTheaterFolderGrants, handleDeferredDeletionRestore };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function theaterFolderListStatus(error: TheaterFolderListError): number {
  if (error.code === "forbidden") return 403;
  if (error.code === "not_found") return 404;
  return 400;
}
