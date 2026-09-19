import type * as http from "node:http";
import { canonicalizeTheaterPathSync, workspaceHash, listTheaterFolders, TheaterFolderListError, type TheaterRegistry, type TheaterRegistration, type createFolderGrantStore } from "./theaters/theater-domain.js";
import { DeferredDeletionError, type createDeferredDeletionCoordinator } from "./deferred-deletion.js";
import type { ConsoleTheaterFolderListResponse, ConsoleTheaterInfo } from "../../../core/host/transport/console-contract-types.js";

type TheaterFolderListBody = { readonly path?: unknown };
type TheaterFolderGrantBody = { readonly path?: unknown };
type CreateTheaterBody = { readonly folderGrantId?: unknown };
type PatchTheaterBody = { readonly order?: unknown };

interface WorkspaceRouteDeps {
  readonly theaters: TheaterRegistry;
  readonly folderGrants: ReturnType<typeof createFolderGrantStore>;
  readonly deletionCoordinator: Pick<ReturnType<typeof createDeferredDeletionCoordinator>, "hasPendingTheater" | "deleteTheater" | "restore">;
  readonly isTerminalAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly listTheaterInfos: () => readonly ConsoleTheaterInfo[];
  readonly toTheaterInfo: (theater: TheaterRegistration, hasWiki: boolean) => ConsoleTheaterInfo;
  readonly publishTheaterLifecycle: (event: "registered", theaterId: string) => void;
  readonly persistDurableState: () => void;
  readonly migrateLegacyCaptureState: () => void;
}

export function createWorkspaceRoutes(deps: WorkspaceRouteDeps) {
  const { theaters, folderGrants, deletionCoordinator, isTerminalAuthorized, readJsonBody, writeJson, listTheaterInfos, toTheaterInfo, publishTheaterLifecycle, persistDurableState, migrateLegacyCaptureState } = deps;
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

  async function handleObserverTheaters(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET") {
      writeJson(res, 200, { theaters: listTheaterInfos() });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<CreateTheaterBody>(req);
    if (!isPlainObject(body) || typeof body.folderGrantId !== "string") {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const cwd = folderGrants.consume(body.folderGrantId);
    if (!cwd) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const canonicalCwd = canonicalizeTheaterPathSync(cwd);
    if (deletionCoordinator.hasPendingTheater(workspaceHash(canonicalCwd))) {
      writeJson(res, 409, { error: "pending_deletion" });
      return;
    }
    const theater = await theaters.register(cwd);
    publishTheaterLifecycle("registered", theater.id);
    persistDurableState();
    writeJson(res, 200, toTheaterInfo(theater, true));
  }

  async function handleObserverTheaterItem(req: http.IncomingMessage, res: http.ServerResponse, theaterId: string): Promise<void> {
    if (req.method !== "PATCH" && req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody<PatchTheaterBody>(req);
      if (!isPlainObject(body) || typeof body.order !== "number" || !Number.isInteger(body.order) || body.order < 0) {
        writeJson(res, 400, { error: "invalid_theater_order" });
        return;
      }
      const theater = theaters.setOrder(theaterId, body.order);
      if (!theater) {
        writeJson(res, 404, { error: "theater_not_found" });
        return;
      }
      persistDurableState();
      writeJson(res, 200, toTheaterInfo(theater, true));
      return;
    }
    const deletion = deletionCoordinator.deleteTheater(theaterId);
    writeJson(res, 200, { ok: true, deletion });
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
      migrateLegacyCaptureState();
      writeJson(res, 200, restored);
    } catch (error) {
      if (error instanceof DeferredDeletionError) {
        writeJson(res, error.status, { error: error.message });
        return;
      }
      throw error;
    }
  }

  return { handleTheaterFoldersList, handleTheaterFolderGrants, handleObserverTheaters, handleObserverTheaterItem, handleDeferredDeletionRestore };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function theaterFolderListStatus(error: TheaterFolderListError): number {
  if (error.code === "forbidden") return 403;
  if (error.code === "not_found") return 404;
  return 400;
}
