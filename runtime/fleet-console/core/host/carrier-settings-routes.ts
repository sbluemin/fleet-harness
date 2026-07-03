import type http from "node:http";

import { CLI_BACKENDS, getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import {
  applyAgentCliTypeSelectionUpdate,
  buildCarrierModelDefaults,
  CLI_DISPLAY_NAMES,
  getAgentCliSelection,
  getCarrierSourceDisplayName,
  getConfiguredTaskForceCarrierIds,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  notifyStatusUpdate,
  normalizeCarrierDisplayNameInput,
  readCarriersSnapshot,
  resetCarrierTaskForceConfig,
  resetTaskForceModelSelection,
  resolveAgentCliType,
  saveAgentCliSelection,
  setCarrierAgentMode,
  setTaskForceConfiguredCarriers,
  StatusOverlayController,
  TASKFORCE_CLI_TYPES,
  updateAgentCliSelection,
  updateCarrierCliType,
  updateCarrierDisplayName,
  updateCarriers,
  updateTaskForceModelSelection,
  type AgentCliSelection,
  type CarrierAgentMode,
  type CarrierConfig,
  type CarrierRegistry,
  type ResolvedCarrierState,
} from "@dotobokuri/fleet-carriers";

import type { ApiCatalogEntry } from "./api-catalog.js";
import type {
  CarrierSettingsCarrier,
  CarrierSettingsCliOption,
  CarrierSettingsModelOption,
  CarrierSettingsMutationResult,
  CarrierSettingsOptions,
  CarrierSettingsState,
  CarrierSettingsTaskForceBackend,
} from "./carrier-settings-types.js";

interface CarrierSettingsRouteDeps {
  readonly registry: CarrierRegistry;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface CarrierSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface ModelBody {
  readonly model?: unknown;
  readonly effort?: unknown;
}

interface PatchBody {
  readonly cli?: unknown;
  readonly model?: unknown;
  readonly displayName?: unknown;
  readonly agentMode?: unknown;
}

type ParsedCarrierMutation =
  | { readonly kind: "patch"; readonly carrierId: string }
  | { readonly kind: "taskforce-backend"; readonly carrierId: string; readonly cliType: string }
  | { readonly kind: "taskforce-all"; readonly carrierId: string };

type JsonBodyResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false };

const SUBAGENT_CLI_TYPES = new Set<CliType>(["claude"]);
const TASKFORCE_MIN_BACKENDS = 2;

export const CARRIER_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/settings/carriers",
    summary: "Get the carrier settings status.",
    category: "Settings",
    gate: "loopback",
  },
  {
    method: "GET",
    path: "/api/v1/settings/carriers/options",
    summary: "Get the carrier settings options.",
    category: "Settings",
    gate: "loopback",
  },
  {
    method: "PATCH",
    path: "/api/v1/settings/carriers/:id",
    summary: "Update carrier settings fields (cli, model, displayName, agentMode).",
    category: "Settings",
    gate: "origin-write",
  },
  {
    method: "PUT",
    path: "/api/v1/settings/carriers/:id/taskforce/:cliType",
    summary: "Set the Task Force backend model.",
    category: "Settings",
    gate: "origin-write",
  },
  {
    method: "DELETE",
    path: "/api/v1/settings/carriers/:id/taskforce/:cliType",
    summary: "Unset the Task Force backend model.",
    category: "Settings",
    gate: "origin-write",
  },
  {
    method: "DELETE",
    path: "/api/v1/settings/carriers/:id/taskforce",
    summary: "Reset the carrier Task Force settings.",
    category: "Settings",
    gate: "origin-write",
  },
];

export function createCarrierSettingsRouter(deps: CarrierSettingsRouteDeps): (context: CarrierSettingsRouteContext) => Promise<boolean> {
  const controller = createStatusOverlayController(deps.registry);

  return async function handleCarrierSettingsRoute(context: CarrierSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/api/v1/settings/carriers") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.writeJson(res, 200, buildCarrierSettingsState(deps.registry));
      return true;
    }
    if (pathname === "/api/v1/settings/carriers/options") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.writeJson(res, 200, buildCarrierSettingsOptions());
      return true;
    }
    const mutation = parseCarrierMutation(pathname);
    if (!mutation) return false;
    await handleCarrierMutation(req, res, deps, controller, mutation);
    return true;
  };
}

export function buildCarrierSettingsState(registry: CarrierRegistry): CarrierSettingsState {
  const defaultsByCarrier = buildDefaultsByCarrier(registry);
  const snapshot = readCarriersSnapshot(defaultsByCarrier);
  return {
    generation: snapshot.generation,
    carriers: getRegisteredOrder(registry).map((carrierId) => {
      const config = requireCarrierConfig(registry, carrierId);
      const resolved = snapshot.carriers[carrierId] ?? fallbackResolvedState(config);
      return toCarrierSettingsCarrier(registry, config, resolved);
    }),
  };
}

export function buildCarrierSettingsOptions(): CarrierSettingsOptions {
  return {
    cliTypes: getCliTypes().map(toCliOption),
    taskForceConstraints: { minBackends: TASKFORCE_MIN_BACKENDS },
  };
}

async function handleCarrierMutation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  controller: StatusOverlayController,
  mutation: ParsedCarrierMutation,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!isExpectedCarrierMethod(mutation, method)) {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isJsonRequest(req)) {
    deps.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  if (!getRegisteredCarrierConfig(deps.registry, mutation.carrierId)) {
    deps.writeJson(res, 404, { error: "carrier_not_found" });
    return;
  }
  if (mutation.kind === "taskforce-backend" && !isCliType(mutation.cliType)) {
    deps.writeJson(res, 400, { error: "invalid_cli_type" });
    return;
  }
  try {
    if (mutation.kind === "patch") {
      await mutateCarrierPatch(req, res, deps, controller, mutation.carrierId);
      return;
    }
    if (mutation.kind === "taskforce-backend") {
      if (method === "DELETE") {
        const body = await readRequiredJsonBody<Record<string, never>>(req, res, deps);
        if (!body.ok) return;
        resetTaskForceModelSelection(mutation.carrierId, mutation.cliType);
        refreshTaskForceConfiguredCarriers(deps.registry);
        writeMutationState(res, deps);
        return;
      }
      const body = await readRequiredJsonBody<ModelBody>(req, res, deps);
      if (!body.ok) return;
      mutateTaskForceBackend(res, deps, mutation.carrierId, mutation.cliType as CliType, body.body);
      return;
    }
    const body = await readRequiredJsonBody<Record<string, never>>(req, res, deps);
    if (!body.ok) return;
    resetCarrierTaskForceConfig(mutation.carrierId);
    refreshTaskForceConfiguredCarriers(deps.registry);
    writeMutationState(res, deps);
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
}

async function mutateCarrierPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  controller: StatusOverlayController,
  carrierId: string,
): Promise<void> {
  const bodyResult = await readRequiredJsonBody<PatchBody>(req, res, deps);
  if (!bodyResult.ok) return;
  const body = bodyResult.body;
  const config = requireCarrierConfig(deps.registry, carrierId);
  const currentCliType = resolveAgentCliType(carrierId, config.defaultCliType);

  // All-or-nothing validation: every provided field must be valid before any apply.
  let newCliType: CliType | undefined;
  if (body.cli !== undefined) {
    const parsed = readCliType(body.cli);
    if (!parsed) { deps.writeJson(res, 400, { error: "invalid_cli_type" }); return; }
    newCliType = parsed;
  }
  const effectiveCliType = newCliType ?? currentCliType;

  let modelSelection: AgentCliSelection | undefined;
  if (body.model !== undefined) {
    const parsed = readSelection(effectiveCliType, body.model as ModelBody);
    if (!parsed) { deps.writeJson(res, 400, { error: "invalid_model_selection" }); return; }
    modelSelection = parsed;
  }

  let normalizedDisplayName: string | undefined;
  if (body.displayName !== undefined) {
    const parsed = normalizeCarrierDisplayNameInput(body.displayName);
    if (parsed === null) { deps.writeJson(res, 400, { error: "invalid_display_name" }); return; }
    normalizedDisplayName = parsed;
  }

  if (body.agentMode !== undefined) {
    if (body.agentMode !== "cli" && body.agentMode !== "subagent") {
      deps.writeJson(res, 400, { error: "invalid_agent_mode" }); return;
    }
    if (body.agentMode === "subagent" && !SUBAGENT_CLI_TYPES.has(effectiveCliType)) {
      deps.writeJson(res, 400, { error: "subagent_unsupported" }); return;
    }
  }

  // Best-effort sequential application.
  if (newCliType) {
    await controller.changeCliType(carrierId, newCliType);
    // 비지원(비-Claude) CLI로 전환하면 SubAgent는 유효하지 않으므로, 불일치 상태가 영속되지 않게 해제한다.
    if (!SUBAGENT_CLI_TYPES.has(newCliType)) {
      const resolved = readCarriersSnapshot(buildDefaultsByCarrier(deps.registry)).carriers[carrierId];
      if (resolved?.agentMode === "subagent") updateCarrierAgentModeAtomically(carrierId, "cli", config.defaultAgentMode ?? "cli");
    }
  }

  if (modelSelection) {
    await updateAgentCliSelection(carrierId, effectiveCliType, modelSelection);
    notifyStatusUpdate(deps.registry);
  }

  if (normalizedDisplayName !== undefined) {
    updateCarrierDisplayName(carrierId, normalizedDisplayName, getCarrierSourceDisplayName(deps.registry, carrierId));
    notifyStatusUpdate(deps.registry);
  }

  if (body.agentMode === "cli" || body.agentMode === "subagent") {
    updateCarrierAgentModeAtomically(carrierId, body.agentMode, config.defaultAgentMode ?? "cli");
    if (body.agentMode === "subagent") refreshTaskForceConfiguredCarriers(deps.registry);
    notifyStatusUpdate(deps.registry);
  }

  writeMutationState(res, deps);
}

function mutateTaskForceBackend(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  carrierId: string,
  cliType: CliType,
  body: ModelBody,
): void {
  const selection = readSelection(cliType, body);
  if (!selection) {
    deps.writeJson(res, 400, { error: "invalid_model_selection" });
    return;
  }
  updateTaskForceBackendAtomically(carrierId, cliType, selection);
  refreshTaskForceConfiguredCarriers(deps.registry);
  notifyStatusUpdate(deps.registry);
  writeMutationState(res, deps);
}

function writeMutationState(res: http.ServerResponse, deps: CarrierSettingsRouteDeps): void {
  const response: CarrierSettingsMutationResult = { state: buildCarrierSettingsState(deps.registry) };
  deps.writeJson(res, 200, response);
}

async function readRequiredJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
): Promise<JsonBodyResult<T>> {
  const body = await deps.readJsonBody<T>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    deps.writeJson(res, 400, { error: "invalid_json" });
    return { ok: false };
  }
  return { ok: true, body };
}

function buildDefaultsByCarrier(registry: CarrierRegistry): Record<string, { readonly cliType: CliType; readonly defaultAgentMode?: CarrierAgentMode; readonly defaultModel?: string; readonly defaultEffort?: string }> {
  return Object.fromEntries(
    getRegisteredOrder(registry).map((carrierId) => {
      const config = requireCarrierConfig(registry, carrierId);
      return [carrierId, {
        cliType: config.defaultCliType,
        ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
        ...buildCarrierModelDefaults(config, config.defaultCliType),
      }];
    }),
  );
}

function toCarrierSettingsCarrier(
  registry: CarrierRegistry,
  config: CarrierConfig,
  resolved: ResolvedCarrierState,
): CarrierSettingsCarrier {
  const cliType = resolved.agentCliType ?? config.defaultCliType;
  const selection = resolved.agentCli[cliType] ?? readDefaultSelection(cliType);
  const taskForceBackends = toTaskForceBackends(resolved.taskforce);
  return {
    carrierId: config.id,
    displayName: resolved.displayName ?? getCarrierSourceDisplayName(registry, config.id),
    sourceDisplayName: getCarrierSourceDisplayName(registry, config.id),
    role: config.carrierMetadata?.title ?? config.displayName,
    roleDescription: config.carrierMetadata?.summary ?? "",
    ...(config.carrierMetadata?.category ? { category: config.carrierMetadata.category } : {}),
    slot: config.slot,
    cliType,
    defaultCliType: config.defaultCliType,
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    agentMode: resolved.agentMode,
    subagentMode: resolved.agentMode === "subagent",
    taskForceBackendCount: taskForceBackends.length,
    taskforce: { backends: taskForceBackends },
  };
}

function toTaskForceBackends(taskforce: ResolvedCarrierState["taskforce"]): readonly CarrierSettingsTaskForceBackend[] {
  return TASKFORCE_CLI_TYPES
    .map((cliType) => {
      const selection = taskforce[cliType];
      if (!selection) return null;
      return {
        cliType,
        model: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {}),
      };
    })
    .filter((backend): backend is CarrierSettingsTaskForceBackend => backend !== null);
}

function toCliOption(cliType: CliType): CarrierSettingsCliOption {
  const provider = getProviderModels(cliType);
  return {
    id: cliType,
    displayName: CLI_DISPLAY_NAMES[cliType] ?? provider.name,
    supportsSubagent: SUBAGENT_CLI_TYPES.has(cliType),
    models: provider.models.map((model): CarrierSettingsModelOption => {
      const effort = getEffort(cliType, model.modelId);
      return {
        modelId: model.modelId,
        name: model.name,
        ...(effort.supported ? { effort: { levels: effort.levels, default: effort.default } } : {}),
      };
    }),
    defaultModel: provider.defaultModel ?? provider.models[0]?.modelId,
  };
}

function createStatusOverlayController(registry: CarrierRegistry): StatusOverlayController {
  return new StatusOverlayController({
    getEntries: () => [],
    getRegisteredOrder: () => getRegisteredOrder(registry),
    getCarrierConfig: (carrierId) => getRegisteredCarrierConfig(registry, carrierId),
    getResolvedCliType: (carrierId) => {
      const config = getRegisteredCarrierConfig(registry, carrierId);
      return config ? resolveAgentCliType(carrierId, config.defaultCliType) : undefined;
    },
    getCurrentModelSelection: (carrierId) => {
      return readCurrentModelSelection(registry, carrierId);
    },
    getAvailableModels: (cliType) => {
      const provider = getProviderModels(cliType);
      return {
        defaultModel: provider.defaultModel,
        models: provider.models.map((model) => ({
          modelId: model.modelId,
          name: model.name,
          effort: getEffort(cliType, model.modelId),
        })),
      };
    },
    getEffort: (cliType, modelId) => getEffort(cliType, modelId),
    getAgentCliSelection: (carrierId, cliType) => getAgentCliSelection(carrierId, cliType),
    saveAgentCliSelection,
    updateCarrierCliType: (carrierId, cliType) => updateCarrierCliType(registry, carrierId, cliType),
    applyAgentCliTypeSelectionUpdate,
    refreshAgentPanel: () => undefined,
    syncModelConfig: () => undefined,
    notifyStatusUpdate: () => notifyStatusUpdate(registry),
  });
}

function updateCarrierAgentModeAtomically(
  carrierId: string,
  agentMode: CarrierAgentMode,
  defaultAgentMode: CarrierAgentMode,
): void {
  if (agentMode === "cli") {
    setCarrierAgentMode(carrierId, false, defaultAgentMode);
    return;
  }
  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[carrierId] ?? {};
    const next = { ...current };
    next.agentMode = "subagent";
    delete next.taskforce;
    carriers[carrierId] = next;
    states.carriers = carriers;
  });
}

function updateTaskForceBackendAtomically(carrierId: string, cliType: CliType, selection: AgentCliSelection): void {
  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[carrierId] ?? {};
    carriers[carrierId] = {
      ...current,
      agentMode: "cli",
      taskforce: {
        ...(current.taskforce ?? {}),
        [cliType]: selection,
      },
    };
    states.carriers = carriers;
  });
}

function refreshTaskForceConfiguredCarriers(registry: CarrierRegistry): void {
  setTaskForceConfiguredCarriers(registry, getConfiguredTaskForceCarrierIds(getRegisteredOrder(registry)));
  notifyStatusUpdate(registry);
}

function readSelection(cliType: CliType, body: ModelBody): AgentCliSelection | null {
  if (typeof body.model !== "string") return null;
  const provider = getProviderModels(cliType);
  if (!provider.models.some((model) => model.modelId === body.model)) return null;
  const effort = getEffort(cliType, body.model);
  if (!effort.supported) {
    return body.effort === undefined ? { model: body.model } : null;
  }
  if (typeof body.effort !== "string" || !effort.levels.includes(body.effort)) return null;
  return { model: body.model, effort: body.effort };
}

function readDefaultSelection(cliType: CliType): AgentCliSelection {
  const provider = getProviderModels(cliType);
  const model = provider.defaultModel;
  const effort = getEffort(cliType, model);
  return {
    model,
    ...(effort.supported ? { effort: effort.default } : {}),
  };
}

function readCurrentModelSelection(registry: CarrierRegistry, carrierId: string): AgentCliSelection | undefined {
  const config = getRegisteredCarrierConfig(registry, carrierId);
  if (!config) return undefined;
  const defaults = {
    [carrierId]: {
      cliType: config.defaultCliType,
      ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
      ...buildCarrierModelDefaults(config, config.defaultCliType),
    },
  };
  const resolved = readCarriersSnapshot(defaults).carriers[carrierId] ?? fallbackResolvedState(config);
  const cliType = resolved.agentCliType ?? config.defaultCliType;
  return resolved.agentCli[cliType] ?? readDefaultSelection(cliType);
}

function fallbackResolvedState(config: CarrierConfig): ResolvedCarrierState {
  return {
    agentMode: config.defaultAgentMode ?? "cli",
    agentCliType: config.defaultCliType,
    agentCli: { [config.defaultCliType]: readDefaultSelection(config.defaultCliType) },
    taskforce: {},
  };
}

function parseCarrierMutation(pathname: string): ParsedCarrierMutation | null {
  const parts = pathname.split("/").filter(Boolean);
  // /api/v1/settings/carriers/:id/...
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "settings" || parts[3] !== "carriers" || !parts[4]) return null;
  const carrierId = safeDecodeURIComponent(parts[4]);
  if (!carrierId) return null;
  if (parts.length === 5) return { kind: "patch", carrierId };
  if (parts.length === 6 && parts[5] === "taskforce") return { kind: "taskforce-all", carrierId };
  if (parts.length === 7 && parts[5] === "taskforce") {
    const cliType = safeDecodeURIComponent(parts[6] ?? "");
    return cliType ? { kind: "taskforce-backend", carrierId, cliType } : null;
  }
  return null;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isExpectedCarrierMethod(mutation: ParsedCarrierMutation, method: string): boolean {
  if (mutation.kind === "taskforce-backend") return method === "PUT" || method === "DELETE";
  if (mutation.kind === "taskforce-all") return method === "DELETE";
  return method === "PATCH";
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function readCliType(value: unknown): CliType | null {
  return typeof value === "string" && isCliType(value) ? value : null;
}

function isCliType(value: string): value is CliType {
  return Object.prototype.hasOwnProperty.call(CLI_BACKENDS, value);
}

function getCliTypes(): readonly CliType[] {
  return Object.keys(CLI_BACKENDS) as CliType[];
}

function requireCarrierConfig(registry: CarrierRegistry, carrierId: string): CarrierConfig {
  const config = getRegisteredCarrierConfig(registry, carrierId);
  if (!config) throw new Error(`Carrier not found: ${carrierId}`);
  return config;
}
