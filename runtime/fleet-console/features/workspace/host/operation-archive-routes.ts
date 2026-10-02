import type http from "node:http";
import type { OperationAccessIntent, OperationAccessResult, OperationDescription, OperationNode, OperationPurgeConfirmation } from "@fleet-console/sdk/operations";
import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import type { OperationArchiveCoordinator } from "./operation-archive.js";
import { OperationArchiveError } from "./operation-archive-storage.js";

export const OPERATION_ARCHIVE_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: "/api/v1/operations/archive", summary: "List archived Operations without restoring them.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/operations/:operationId/describe", summary: "Read Operation metadata in either location.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/operations/:operationId/archive", summary: "Archive an Operation and its descendants without purging data.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/:operationId/access", summary: "Restore the complete Cluster for explicit use.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/:operationId/restore", summary: "Restore the complete Cluster dormant.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/archive/undo", summary: "Undo the matching archive receipt.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/operations/archive/:operationId/purge-preview", summary: "Read the exact archived deletion set and revision.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/operations/archive/purge", summary: "Schedule the confirmed archived set for deletion after a 10-second undo window.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/archive/purge-preview", summary: "Read the exact archived batch and revision.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/archive/purge-undo", summary: "Cancel a pending archive deletion.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/operations/archive/restore", summary: "Restore the confirmed archived batch dormant, atomically.", category: "Operations", gate: "origin-write", transport: "http" },
];

export function createOperationArchiveRouter(deps: {
  readonly archive: OperationArchiveCoordinator;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly sanitize: (operation: OperationNode) => OperationNode;
}) {
  const description = (value: OperationDescription | null) => value ? { ...value, operation: deps.sanitize(value.operation) } : null;
  const access = (value: OperationAccessResult) => ({ ...value, operations: value.operations.map(deps.sanitize) });
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    const batchPreview = pathname === "/api/v1/operations/archive/purge-preview";
    const batchRestore = pathname === "/api/v1/operations/archive/restore";
    const purgeUndo = pathname === "/api/v1/operations/archive/purge-undo";
    const item = batchRestore ? null : pathname.match(/^\/api\/v1\/operations\/([^/]+)\/(archive|describe|access|restore)$/);
    const preview = pathname.match(/^\/api\/v1\/operations\/archive\/([^/]+)\/purge-preview$/);
    const collection = pathname === "/api/v1/operations/archive";
    const undo = pathname === "/api/v1/operations/archive/undo";
    const purge = pathname === "/api/v1/operations/archive/purge";
    if (!item && !preview && !collection && !undo && !purge && !batchPreview && !batchRestore && !purgeUndo) return false;
    const read = collection || !!preview || item?.[2] === "describe";
    if (req.method !== (read ? "GET" : "POST")) { deps.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!read && !deps.isAuthorized(req)) { deps.writeJson(res, 401, { error: "unauthorized" }); return true; }
    try {
      const id = item || preview ? decodeURIComponent((item ?? preview)![1]!) : "";
      if ((item || preview) && (!id || id.length > 128)) throw new OperationArchiveError(400, "invalid_archive_request");
      let result: unknown;
      if (collection) {
        const theaterId = new URL(req.url ?? "/", "http://localhost").searchParams.get("theaterId") ?? undefined;
        const snapshot = deps.archive.listArchived(theaterId);
        result = { ...snapshot, entries: snapshot.entries.map((entry) => description(entry)) };
      } else if (preview) result = deps.archive.previewPurge(id);
      else if (item?.[2] === "describe") result = description(deps.archive.describe(id));
      else {
        const body = await deps.readJsonBody<Record<string, unknown>>(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new OperationArchiveError(400, "invalid_archive_request");
        if (undo) {
          if (typeof body.targetId !== "string" || typeof body.archiveId !== "string") throw new OperationArchiveError(400, "invalid_archive_request");
          result = access(await deps.archive.undoArchive({ targetId: body.targetId, archiveId: body.archiveId }));
        } else if (purgeUndo) {
          if (typeof body.purgeId !== "string" || !body.purgeId || body.purgeId.length > 128) throw new OperationArchiveError(400, "invalid_archive_request");
          result = await deps.archive.undoPurge(body.purgeId);
        } else if (batchPreview) {
          if (!Array.isArray(body.operationIds)) throw new OperationArchiveError(400, "invalid_archive_request");
          result = deps.archive.previewBatch(body.operationIds);
        } else if (purge || batchRestore) {
          if (typeof body.targetId !== "string" || !Array.isArray(body.operationIds) || !body.operationIds.length || !body.operationIds.every((id) => typeof id === "string") || !Number.isSafeInteger(body.revision)) throw new OperationArchiveError(400, "invalid_archive_request");
          const confirmation = body as unknown as OperationPurgeConfirmation;
          if (batchRestore) {
            const restored = await deps.archive.restoreBatch(confirmation);
            result = { ...restored, operations: restored.operations.map(deps.sanitize) };
          } else result = await deps.archive.purge(confirmation);
        } else if (item?.[2] === "archive") result = await deps.archive.archive(id);
        else {
          const intent = item?.[2] === "restore" ? "ensure-active" : body.intent ?? "ensure-active";
          if (!["ensure-active", "open", "activate", "resume"].includes(String(intent))) throw new OperationArchiveError(400, "invalid_archive_request");
          result = access(await deps.archive.access(id, intent as OperationAccessIntent));
        }
      }
      deps.writeJson(res, 200, result);
    } catch (error) {
      deps.writeJson(res, error instanceof OperationArchiveError ? error.status : 503, { error: error instanceof OperationArchiveError ? error.message : "archive_recovery_required" });
    }
    return true;
  };
}
