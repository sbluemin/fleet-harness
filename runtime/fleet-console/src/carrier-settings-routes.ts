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

interface CliBody {
  readonly cliType?: unknown;
}

interface ModelBody {
  readonly model?: unknown;
  readonly effort?: unknown;
}

interface DisplayNameBody {
  readonly displayName?: unknown;
}

interface AgentModeBody {
  readonly agentMode?: unknown;
}

type ParsedCarrierMutation =
  | { readonly kind: "cli"; readonly carrierId: string }
  | { readonly kind: "model"; readonly carrierId: string }
  | { readonly kind: "display-name"; readonly carrierId: string }
  | { readonly kind: "agent-mode"; readonly carrierId: string }
  | { readonly kind: "taskforce-backend"; readonly carrierId: string; readonly cliType: string }
  | { readonly kind: "taskforce-all"; readonly carrierId: string };

type JsonBodyResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false };

const SUBAGENT_CLI_TYPES = new Set<CliType>(["claude", "claude-zai", "claude-kimi", "claude-glm"]);
const TASKFORCE_MIN_BACKENDS = 2;

export const CARRIER_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/carrier-settings/state",
    summary: "Get the carrier settings status.",
    category: "Carrier Settings",
    gate: "loopback",
  },
  {
    method: "GET",
    path: "/carrier-settings/options",
    summary: "Get the carrier settings options.",
    category: "Carrier Settings",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: "/carrier-settings/carriers/:id/cli",
    summary: "Change the carrier Agent CLI.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "PUT",
    path: "/carrier-settings/carriers/:id/model",
    summary: "Change the carrier model selection.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "PATCH",
    path: "/carrier-settings/carriers/:id/display-name",
    summary: "Change the carrier display name.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "PUT",
    path: "/carrier-settings/carriers/:id/agent-mode",
    summary: "Change the carrier execution mode.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "PUT",
    path: "/carrier-settings/carriers/:id/taskforce/:cliType",
    summary: "Set the Task Force backend model.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "DELETE",
    path: "/carrier-settings/carriers/:id/taskforce/:cliType",
    summary: "Unset the Task Force backend model.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
  {
    method: "DELETE",
    path: "/carrier-settings/carriers/:id/taskforce",
    summary: "Reset the carrier Task Force settings.",
    category: "Carrier Settings",
    gate: "terminal-origin",
  },
];

export function createCarrierSettingsRouter(deps: CarrierSettingsRouteDeps): (context: CarrierSettingsRouteContext) => Promise<boolean> {
  const controller = createStatusOverlayController(deps.registry);

  return async function handleCarrierSettingsRoute(context: CarrierSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/carrier-settings/state") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.writeJson(res, 200, buildCarrierSettingsState(deps.registry));
      return true;
    }
    if (pathname === "/carrier-settings/options") {
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
  const expectedMethod = mutation.kind === "display-name" ? "PATCH" : mutation.kind === "taskforce-backend" || mutation.kind === "taskforce-all" ? method : "PUT";
  if (!isExpectedCarrierMethod(mutation, method, expectedMethod)) {
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
    if (mutation.kind === "cli") {
      const body = await readRequiredJsonBody<CliBody>(req, res, deps);
      if (!body.ok) return;
      await mutateCarrierCli(res, deps, controller, mutation.carrierId, body.body);
      return;
    }
    if (mutation.kind === "model") {
      const body = await readRequiredJsonBody<ModelBody>(req, res, deps);
      if (!body.ok) return;
      await mutateCarrierModel(res, deps, mutation.carrierId, body.body);
      return;
    }
    if (mutation.kind === "display-name") {
      const body = await readRequiredJsonBody<DisplayNameBody>(req, res, deps);
      if (!body.ok) return;
      mutateDisplayName(res, deps, mutation.carrierId, body.body);
      return;
    }
    if (mutation.kind === "agent-mode") {
      const body = await readRequiredJsonBody<AgentModeBody>(req, res, deps);
      if (!body.ok) return;
      mutateAgentMode(res, deps, mutation.carrierId, body.body);
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

async function mutateCarrierCli(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  controller: StatusOverlayController,
  carrierId: string,
  body: CliBody,
): Promise<void> {
  const cliType = readCliType(body.cliType);
  if (!cliType) {
    deps.writeJson(res, 400, { error: "invalid_cli_type" });
    return;
  }
  await controller.changeCliType(carrierId, cliType);
  // 비지원(비-Claude) CLI로 전환하면 SubAgent는 유효하지 않다. agent-mode 라우트는 비지원 CLI의
  // SA enable을 거부하지만 CLI 변경 경로는 그 가드를 우회하므로, 여기서 SA를 해제해 codex+subagent
  // 같은 불일치 상태가 서버에 영속되지 않게 한다.
  if (!SUBAGENT_CLI_TYPES.has(cliType)) {
    const resolved = readCarriersSnapshot(buildDefaultsByCarrier(deps.registry)).carriers[carrierId];
    if (resolved?.agentMode === "subagent") {
      const config = requireCarrierConfig(deps.registry, carrierId);
      updateCarrierAgentModeAtomically(carrierId, "cli", config.defaultAgentMode ?? "cli");
    }
  }
  writeMutationState(res, deps);
}

async function mutateCarrierModel(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  carrierId: string,
  body: ModelBody,
): Promise<void> {
  const config = requireCarrierConfig(deps.registry, carrierId);
  const cliType = resolveAgentCliType(carrierId, config.defaultCliType);
  const selection = readSelection(cliType, body);
  if (!selection) {
    deps.writeJson(res, 400, { error: "invalid_model_selection" });
    return;
  }
  await updateAgentCliSelection(carrierId, cliType, selection);
  notifyStatusUpdate(deps.registry);
  writeMutationState(res, deps);
}

function mutateDisplayName(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  carrierId: string,
  body: DisplayNameBody,
): void {
  const displayName = normalizeCarrierDisplayNameInput(body.displayName);
  if (displayName === null) {
    deps.writeJson(res, 400, { error: "invalid_display_name" });
    return;
  }
  updateCarrierDisplayName(carrierId, displayName, getCarrierSourceDisplayName(deps.registry, carrierId));
  notifyStatusUpdate(deps.registry);
  writeMutationState(res, deps);
}

function mutateAgentMode(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  carrierId: string,
  body: AgentModeBody,
): void {
  const config = requireCarrierConfig(deps.registry, carrierId);
  const agentMode = body.agentMode;
  if (agentMode !== "cli" && agentMode !== "subagent") {
    deps.writeJson(res, 400, { error: "invalid_agent_mode" });
    return;
  }
  const cliType = resolveAgentCliType(carrierId, config.defaultCliType);
  if (agentMode === "subagent" && !SUBAGENT_CLI_TYPES.has(cliType)) {
    deps.writeJson(res, 400, { error: "subagent_unsupported" });
    return;
  }
  updateCarrierAgentModeAtomically(carrierId, agentMode, config.defaultAgentMode ?? "cli");
  if (agentMode === "subagent") refreshTaskForceConfiguredCarriers(deps.registry);
  notifyStatusUpdate(deps.registry);
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
  if (parts[0] !== "carrier-settings" || parts[1] !== "carriers" || !parts[2]) return null;
  const carrierId = safeDecodeURIComponent(parts[2]);
  if (!carrierId) return null;
  if (parts.length === 4 && parts[3] === "cli") return { kind: "cli", carrierId };
  if (parts.length === 4 && parts[3] === "model") return { kind: "model", carrierId };
  if (parts.length === 4 && parts[3] === "display-name") return { kind: "display-name", carrierId };
  if (parts.length === 4 && parts[3] === "agent-mode") return { kind: "agent-mode", carrierId };
  if (parts.length === 4 && parts[3] === "taskforce") return { kind: "taskforce-all", carrierId };
  if (parts.length === 5 && parts[3] === "taskforce") {
    const cliType = safeDecodeURIComponent(parts[4] ?? "");
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

function isExpectedCarrierMethod(mutation: ParsedCarrierMutation, method: string, expectedMethod: string): boolean {
  if (mutation.kind === "taskforce-backend") return method === "PUT" || method === "DELETE";
  if (mutation.kind === "taskforce-all") return method === "DELETE";
  return method === expectedMethod;
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
