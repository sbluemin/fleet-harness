import type http from "node:http";

import {
  sanitizeWorkspacePresetLayout,
  type WorkspacePresetApplyResult,
} from "../durable-state.js";
import type { OperationStore } from "../operations/types.js";
import type { TheaterRegistry } from "../theaters.js";
import type { WorkspacePresetStore } from "./store.js";

export interface WorkspacePresetsRouterDeps {
  readonly store: WorkspacePresetStore;
  readonly operations: OperationStore;
  readonly theaters: TheaterRegistry;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
  readonly persist: () => void;
}

type WorkspacePresetsRouter = (context: {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}) => Promise<boolean>;

export function createWorkspacePresetsRouter(deps: WorkspacePresetsRouterDeps): WorkspacePresetsRouter {
  return async ({ req, res, pathname }) => {
    const collectionMatch = pathname.match(/^\/api\/v1\/theaters\/([^/]+)\/workspace-presets$/u);
    if (collectionMatch) {
      await handleCollection(req, res, decodeURIComponent(collectionMatch[1] ?? ""), deps);
      return true;
    }
    const applyMatch = pathname.match(/^\/api\/v1\/theaters\/([^/]+)\/workspace-presets\/([^/]+)\/apply$/u);
    if (applyMatch) {
      await handleApply(
        req,
        res,
        decodeURIComponent(applyMatch[1] ?? ""),
        decodeURIComponent(applyMatch[2] ?? ""),
        deps,
      );
      return true;
    }
    const itemMatch = pathname.match(/^\/api\/v1\/theaters\/([^/]+)\/workspace-presets\/([^/]+)$/u);
    if (itemMatch) {
      await handleItem(
        req,
        res,
        decodeURIComponent(itemMatch[1] ?? ""),
        decodeURIComponent(itemMatch[2] ?? ""),
        deps,
      );
      return true;
    }
    return false;
  };
}

async function handleCollection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  theaterId: string,
  deps: WorkspacePresetsRouterDeps,
): Promise<void> {
  if (req.method === "GET") {
    deps.writeJson(res, 200, { workspacePresets: deps.store.list(theaterId) });
    return;
  }
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!deps.theaters.get(theaterId)) {
    deps.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }
  const body = await deps.readJsonBody<{ readonly name?: unknown; readonly layout?: unknown }>(req);
  const layout = sanitizeWorkspacePresetLayout(body?.layout);
  if (!body || typeof body.name !== "string" || !layout) {
    deps.writeJson(res, 400, { error: "invalid_workspace_preset" });
    return;
  }
  try {
    const preset = deps.store.create(theaterId, body.name, layout);
    deps.persist();
    deps.writeJson(res, 201, { workspacePreset: preset });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_workspace_preset" });
  }
}

async function handleItem(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  theaterId: string,
  presetId: string,
  deps: WorkspacePresetsRouterDeps,
): Promise<void> {
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "DELETE") {
    const deleted = deps.store.delete(theaterId, presetId);
    if (deleted) deps.persist();
    deps.writeJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "workspace_preset_not_found" });
    return;
  }
  const body = await deps.readJsonBody<{ readonly name?: unknown }>(req);
  if (!body || typeof body.name !== "string") {
    deps.writeJson(res, 400, { error: "invalid_workspace_preset_patch" });
    return;
  }
  try {
    const preset = deps.store.rename(theaterId, presetId, body.name);
    if (!preset) {
      deps.writeJson(res, 404, { error: "workspace_preset_not_found" });
      return;
    }
    deps.persist();
    deps.writeJson(res, 200, { workspacePreset: preset });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_workspace_preset_patch" });
  }
}

async function handleApply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  theaterId: string,
  presetId: string,
  deps: WorkspacePresetsRouterDeps,
): Promise<void> {
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const preset = deps.store.get(theaterId, presetId);
  if (!preset) {
    deps.writeJson(res, 404, { error: "workspace_preset_not_found" });
    return;
  }

  const currentOperations = deps.operations.list();
  const currentById = new Map(deps.operations.listByTheater(theaterId).map((operation) => [operation.id, operation]));
  const appliedOperationIds: string[] = [];
  const missingOperationIds: string[] = [];
  const nextGeometryById = new Map<string, typeof currentOperations[number]["geometry"]>();
  for (const [operationId, geometry] of Object.entries(preset.layout.operationGeometries)) {
    if (currentById.has(operationId)) {
      appliedOperationIds.push(operationId);
      nextGeometryById.set(operationId, { ...geometry });
    } else {
      missingOperationIds.push(operationId);
    }
  }
  if (appliedOperationIds.length > 0) {
    deps.operations.replace(currentOperations.map((operation) => {
      const geometry = nextGeometryById.get(operation.id);
      return geometry ? { ...operation, geometry } : operation;
    }));
    deps.persist();
  }
  const result: WorkspacePresetApplyResult = {
    preset,
    appliedOperationIds,
    missingOperationIds,
  };
  deps.writeJson(res, 200, result);
}
