import type http from "node:http";

import { CLI_BACKENDS, getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import {
  applyAgentCliTypeSelectionUpdate,
  buildCarrierModelDefaults,
  CLI_DISPLAY_NAMES,
  getAgentCliSelection,
  getCarrierSourceDisplayName,
  isTaskForceCapable,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  notifyStatusUpdate,
  normalizeCarrierDisplayNameInput,
  readCarriersSnapshot,
  clearTaskForceConfig,
  removeTaskForceBackend,
  resolveAgentCliType,
  saveAgentCliSelection,
  setTaskForceBackend,
  StatusOverlayController,
  TASKFORCE_CLI_TYPES,
  updateAgentCliSelection,
  updateCarrierCliType,
  updateCarrierDisplayName,
  TASKFORCE_MIN_BACKENDS,
  type AgentCliSelection,
  type CarrierConfig,
  CARRIER_PRESENTATION_LOCALES,
  type CarrierPresentationLocale,
  type CarrierRegistry,
  type ResolvedCarrierState,
  resolveCarrierPresentation,
} from "@dotobokuri/fleet-carriers";

import type {
  CarrierSettingsCarrier,
  CarrierSettingsCliOption,
  CarrierSettingsModelOption,
  CarrierSettingsMutationResult,
  CarrierSettingsOptions,
  CarrierSettingsState,
  CarrierSettingsTaskForceBackend,
} from "../shared/carrier-settings-types.js";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

type CarrierPresentationLocaleSetsMatch = [
  Exclude<ConsoleLocale, CarrierPresentationLocale>,
  Exclude<CarrierPresentationLocale, ConsoleLocale>,
] extends [never, never] ? true : false;

// Keep the browser and Carrier presentation locale sets synchronized in both directions.
const CARRIER_SETTINGS_PRESENTATION_LOCALES:
  CarrierPresentationLocaleSetsMatch extends true ? typeof CARRIER_PRESENTATION_LOCALES : never =
  CARRIER_PRESENTATION_LOCALES;

interface CarrierSettingsRouteDeps {
  readonly registry: CarrierRegistry;
}

interface ModelBody {
  readonly model?: unknown;
  readonly effort?: unknown;
}

interface PatchBody {
  readonly cli?: unknown;
  readonly model?: unknown;
  readonly displayName?: unknown;
}

type ParsedCarrierMutation =
  | { readonly kind: "patch"; readonly carrierId: string }
  | { readonly kind: "taskforce-backend"; readonly carrierId: string; readonly cliType: string }
  | { readonly kind: "taskforce-all"; readonly carrierId: string };

type JsonBodyResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false };

export function registerCarrierSettingsRoutes(ctx: FleetPluginServerContext, deps: CarrierSettingsRouteDeps): void {
  const controller = createStatusOverlayController(deps.registry);

  registerRouter(ctx, `/api/v1/plugins/${ctx.pluginId}/carriers`, async ({ req, res, pathname }) => {
    if (pathname === "/api/v1/plugins/terminal/carriers") {
      if (req.method !== "GET") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      ctx.host.http.writeJson(res, 200, buildCarrierSettingsState(deps.registry));
      return true;
    }
    if (pathname === "/api/v1/plugins/terminal/carriers/options") {
      if (req.method !== "GET") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      ctx.host.http.writeJson(res, 200, buildCarrierSettingsOptions());
      return true;
    }
    const mutation = parseCarrierMutation(pathname);
    if (!mutation) return false;
    await handleCarrierMutation(req, res, deps, ctx, controller, mutation);
    return true;
  });
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
  ctx: FleetPluginServerContext,
  controller: StatusOverlayController,
  mutation: ParsedCarrierMutation,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!isExpectedCarrierMethod(mutation, method)) {
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isJsonRequest(req)) {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  if (!getRegisteredCarrierConfig(deps.registry, mutation.carrierId)) {
    ctx.host.http.writeJson(res, 404, { error: "carrier_not_found" });
    return;
  }
  if (mutation.kind === "taskforce-backend" && method === "PUT" && !isTaskForceCapable(deps.registry, mutation.carrierId)) {
    ctx.host.http.writeJson(res, 409, { error: "taskforce_not_capable" });
    return;
  }
  if (mutation.kind === "taskforce-backend" && !isCliType(mutation.cliType)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_cli_type" });
    return;
  }
  try {
    if (mutation.kind === "patch") {
      await mutateCarrierPatch(req, res, deps, ctx, controller, mutation.carrierId);
      return;
    }
    if (mutation.kind === "taskforce-backend") {
      if (method === "DELETE") {
        const body = await readRequiredJsonBody<Record<string, never>>(req, res, ctx);
        if (!body.ok) return;
        removeTaskForceBackend(mutation.carrierId, mutation.cliType);
        notifyStatusUpdate(deps.registry);
        writeMutationState(res, deps, ctx);
        return;
      }
      const body = await readRequiredJsonBody<ModelBody>(req, res, ctx);
      if (!body.ok) return;
      mutateTaskForceBackend(res, deps, ctx, mutation.carrierId, mutation.cliType as CliType, body.body);
      return;
    }
    const body = await readRequiredJsonBody<Record<string, never>>(req, res, ctx);
    if (!body.ok) return;
    clearTaskForceConfig(mutation.carrierId);
    notifyStatusUpdate(deps.registry);
    writeMutationState(res, deps, ctx);
  } catch (error) {
    ctx.host.http.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
}

async function mutateCarrierPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  ctx: FleetPluginServerContext,
  controller: StatusOverlayController,
  carrierId: string,
): Promise<void> {
  const bodyResult = await readRequiredJsonBody<PatchBody>(req, res, ctx);
  if (!bodyResult.ok) return;
  const body = bodyResult.body;
  const config = requireCarrierConfig(deps.registry, carrierId);
  const currentCliType = resolveAgentCliType(carrierId, config.defaultCliType);

  // All-or-nothing validation: every provided field must be valid before any apply.
  let newCliType: CliType | undefined;
  if (body.cli !== undefined) {
    const parsed = readCliType(body.cli);
    if (!parsed) { ctx.host.http.writeJson(res, 400, { error: "invalid_cli_type" }); return; }
    newCliType = parsed;
  }
  const effectiveCliType = newCliType ?? currentCliType;

  let modelSelection: AgentCliSelection | undefined;
  if (body.model !== undefined) {
    const parsed = readSelection(effectiveCliType, body.model as ModelBody);
    if (!parsed) { ctx.host.http.writeJson(res, 400, { error: "invalid_model_selection" }); return; }
    modelSelection = parsed;
  }

  let normalizedDisplayName: string | undefined;
  if (body.displayName !== undefined) {
    const parsed = normalizeCarrierDisplayNameInput(body.displayName);
    if (parsed === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_display_name" }); return; }
    normalizedDisplayName = parsed;
  }

  // Best-effort sequential application.
  if (newCliType) {
    await controller.changeCliType(carrierId, newCliType);
  }

  if (modelSelection) {
    await updateAgentCliSelection(carrierId, effectiveCliType, modelSelection);
    notifyStatusUpdate(deps.registry);
  }

  if (normalizedDisplayName !== undefined) {
    updateCarrierDisplayName(carrierId, normalizedDisplayName, getCarrierSourceDisplayName(deps.registry, carrierId));
    notifyStatusUpdate(deps.registry);
  }

  writeMutationState(res, deps, ctx);
}

function mutateTaskForceBackend(
  res: http.ServerResponse,
  deps: CarrierSettingsRouteDeps,
  ctx: FleetPluginServerContext,
  carrierId: string,
  cliType: CliType,
  body: ModelBody,
): void {
  const selection = readSelection(cliType, body);
  if (!selection) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_model_selection" });
    return;
  }
  setTaskForceBackend(deps.registry, carrierId, cliType, selection);
  notifyStatusUpdate(deps.registry);
  writeMutationState(res, deps, ctx);
}

function writeMutationState(res: http.ServerResponse, deps: CarrierSettingsRouteDeps, ctx: FleetPluginServerContext): void {
  const response: CarrierSettingsMutationResult = { state: buildCarrierSettingsState(deps.registry) };
  ctx.host.http.writeJson(res, 200, response);
}

async function readRequiredJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<JsonBodyResult<T>> {
  const body = await ctx.host.http.readJsonBody<T>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_json" });
    return { ok: false };
  }
  return { ok: true, body };
}

function buildDefaultsByCarrier(registry: CarrierRegistry): Record<string, { readonly cliType: CliType; readonly defaultModel?: string; readonly defaultEffort?: string }> {
  return Object.fromEntries(
    getRegisteredOrder(registry).map((carrierId) => {
      const config = requireCarrierConfig(registry, carrierId);
      return [carrierId, {
        cliType: config.defaultCliType,
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
  const taskForceBackends = toTaskForceBackends(registry, config.id, resolved.taskforce);
  const canonicalPresentation = {
    title: config.carrierMetadata?.title ?? config.displayName,
    summary: config.carrierMetadata?.summary ?? "",
  };
  return {
    carrierId: config.id,
    displayName: resolved.displayName ?? getCarrierSourceDisplayName(registry, config.id),
    sourceDisplayName: getCarrierSourceDisplayName(registry, config.id),
    role: canonicalPresentation.title,
    roleDescription: canonicalPresentation.summary,
    localizedPresentation: Object.fromEntries(
      CARRIER_SETTINGS_PRESENTATION_LOCALES.map((locale) => {
        const presentation = resolveCarrierPresentation(
          locale,
          config.id,
          canonicalPresentation,
          config.carrierPresentation,
        );
        return [locale, { role: presentation.title, roleDescription: presentation.summary }];
      }),
    ) as CarrierSettingsCarrier["localizedPresentation"],
    ...(config.carrierMetadata?.category ? { category: config.carrierMetadata.category } : {}),
    slot: config.slot,
    cliType,
    defaultCliType: config.defaultCliType,
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    taskForceCapable: isTaskForceCapable(registry, config.id),
    taskforce: { backends: taskForceBackends },
  };
}

function toTaskForceBackends(registry: CarrierRegistry, carrierId: string, taskforce: ResolvedCarrierState["taskforce"]): readonly CarrierSettingsTaskForceBackend[] {
  if (!isTaskForceCapable(registry, carrierId)) return [];
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
      ...buildCarrierModelDefaults(config, config.defaultCliType),
    },
  };
  const resolved = readCarriersSnapshot(defaults).carriers[carrierId] ?? fallbackResolvedState(config);
  const cliType = resolved.agentCliType ?? config.defaultCliType;
  return resolved.agentCli[cliType] ?? readDefaultSelection(cliType);
}

function fallbackResolvedState(config: CarrierConfig): ResolvedCarrierState {
  return {
    agentCliType: config.defaultCliType,
    agentCli: { [config.defaultCliType]: readDefaultSelection(config.defaultCliType) },
    taskforce: {},
  };
}

function parseCarrierMutation(pathname: string): ParsedCarrierMutation | null {
  const parts = pathname.split("/").filter(Boolean);
  // /api/v1/plugins/terminal/carriers/:id/...
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "plugins" || parts[3] !== "terminal" || parts[4] !== "carriers" || !parts[5]) return null;
  const carrierId = safeDecodeURIComponent(parts[5]);
  if (!carrierId) return null;
  if (parts.length === 6) return { kind: "patch", carrierId };
  if (parts.length === 7 && parts[6] === "taskforce") return { kind: "taskforce-all", carrierId };
  if (parts.length === 8 && parts[6] === "taskforce") {
    const cliType = safeDecodeURIComponent(parts[7] ?? "");
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
