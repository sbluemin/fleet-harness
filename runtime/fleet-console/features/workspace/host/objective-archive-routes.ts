import type http from "node:http";
import type { ObjectiveAccessIntent, ObjectiveAccessResult, ObjectiveDescription, ObjectivePurgeConfirmation } from "../../objectives/shared/records/archive.js";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { ObjectiveArchiveCoordinator } from "./objective-archive.js";
import { ObjectiveArchiveError } from "./objective-archive-storage.js";

export const OBJECTIVE_ARCHIVE_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: "/api/v1/objectives/records/archive", summary: "List archived Objectives without restoring them.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/objectives/records/:objectiveId/describe", summary: "Read Objective metadata in either location.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/:objectiveId/archive", summary: "Archive an Objective and its descendants without purging data.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/:objectiveId/access", summary: "Restore the complete Cluster for explicit use.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/:objectiveId/restore", summary: "Restore the complete Cluster without starting processes; chats are live/idle and terminals are dormant.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/archive/undo", summary: "Undo the matching archive receipt.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/objectives/records/archive/:objectiveId/purge-preview", summary: "Read the exact archived deletion set and revision.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/archive/purge", summary: "Schedule the confirmed archived set for deletion after a 10-second undo window.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/archive/purge-preview", summary: "Read the exact archived batch and revision.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/archive/purge-undo", summary: "Cancel a pending archive deletion.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/archive/restore", summary: "Restore the confirmed archived batch atomically, without starting processes.", category: "Objectives", gate: "origin-write", transport: "http" },
];

export function createObjectiveArchiveRouter(deps: {
  readonly archive: ObjectiveArchiveCoordinator;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly sanitize: (objectiveRecord: ObjectiveRecord) => ObjectiveRecord;
}) {
  const description = (value: ObjectiveDescription | null) => value ? { ...value, objectiveRecord: deps.sanitize(value.objectiveRecord) } : null;
  const access = (value: ObjectiveAccessResult) => ({ ...value, objectiveRecords: value.objectiveRecords.map(deps.sanitize) });
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    const batchPreview = pathname === "/api/v1/objectives/records/archive/purge-preview";
    const batchRestore = pathname === "/api/v1/objectives/records/archive/restore";
    const purgeUndo = pathname === "/api/v1/objectives/records/archive/purge-undo";
    const item = batchRestore ? null : pathname.match(/^\/api\/v1\/objectives\/records\/([^/]+)\/(archive|describe|access|restore)$/);
    const preview = pathname.match(/^\/api\/v1\/objectives\/records\/archive\/([^/]+)\/purge-preview$/);
    const collection = pathname === "/api/v1/objectives/records/archive";
    const undo = pathname === "/api/v1/objectives/records/archive/undo";
    const purge = pathname === "/api/v1/objectives/records/archive/purge";
    if (!item && !preview && !collection && !undo && !purge && !batchPreview && !batchRestore && !purgeUndo) return false;
    const read = collection || !!preview || item?.[2] === "describe";
    if (req.method !== (read ? "GET" : "POST")) { deps.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!read && !deps.isAuthorized(req)) { deps.writeJson(res, 401, { error: "unauthorized" }); return true; }
    try {
      const id = item || preview ? decodeURIComponent((item ?? preview)![1]!) : "";
      if ((item || preview) && (!id || id.length > 128)) throw new ObjectiveArchiveError(400, "invalid_archive_request");
      let result: unknown;
      if (collection) {
        const theaterId = new URL(req.url ?? "/", "http://localhost").searchParams.get("theaterId") ?? undefined;
        const snapshot = deps.archive.listArchived(theaterId);
        result = { ...snapshot, entries: snapshot.entries.map((entry) => description(entry)) };
      } else if (preview) result = deps.archive.previewPurge(id);
      else if (item?.[2] === "describe") result = description(deps.archive.describe(id));
      else {
        const body = await deps.readJsonBody<Record<string, unknown>>(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ObjectiveArchiveError(400, "invalid_archive_request");
        if (undo) {
          if (typeof body.targetId !== "string" || typeof body.archiveId !== "string") throw new ObjectiveArchiveError(400, "invalid_archive_request");
          result = access(await deps.archive.undoArchive({ targetId: body.targetId, archiveId: body.archiveId }));
        } else if (purgeUndo) {
          if (typeof body.purgeId !== "string" || !body.purgeId || body.purgeId.length > 128) throw new ObjectiveArchiveError(400, "invalid_archive_request");
          result = await deps.archive.undoPurge(body.purgeId);
        } else if (batchPreview) {
          if (!Array.isArray(body.objectiveIds)) throw new ObjectiveArchiveError(400, "invalid_archive_request");
          result = deps.archive.previewBatch(body.objectiveIds);
        } else if (purge || batchRestore) {
          if (typeof body.targetId !== "string" || !Array.isArray(body.objectiveIds) || !body.objectiveIds.length || !body.objectiveIds.every((id) => typeof id === "string") || !Number.isSafeInteger(body.revision)) throw new ObjectiveArchiveError(400, "invalid_archive_request");
          const confirmation = body as unknown as ObjectivePurgeConfirmation;
          if (batchRestore) {
            const restored = await deps.archive.restoreBatch(confirmation);
            result = { ...restored, objectiveRecords: restored.objectiveRecords.map(deps.sanitize) };
          } else result = await deps.archive.purge(confirmation);
        } else if (item?.[2] === "archive") result = await deps.archive.archive(id);
        else {
          const intent = item?.[2] === "restore" ? "ensure-active" : body.intent ?? "ensure-active";
          if (!["ensure-active", "open", "activate", "resume"].includes(String(intent))) throw new ObjectiveArchiveError(400, "invalid_archive_request");
          result = access(await deps.archive.access(id, intent as ObjectiveAccessIntent));
        }
      }
      deps.writeJson(res, 200, result);
    } catch (error) {
      deps.writeJson(res, error instanceof ObjectiveArchiveError ? error.status : 503, { error: error instanceof ObjectiveArchiveError ? error.message : "archive_recovery_required" });
    }
    return true;
  };
}
