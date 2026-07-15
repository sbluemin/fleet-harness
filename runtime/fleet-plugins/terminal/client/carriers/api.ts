
import type {
  CarrierSettingsCarrier,
  CarrierSettingsCliOption,
  CarrierSettingsModelOption,
  CarrierSettingsMutationResult,
  CarrierSettingsOptions,
  CarrierSettingsState,
  CarrierSettingsTaskForceBackend,
} from "../../shared/carrier-settings-types.js";

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ModelSelection {
  readonly model: string;
  readonly effort?: string;
}

interface CarrierPatch {
  readonly cli?: string;
  readonly model?: ModelSelection;
  readonly displayName?: string;
}

const LEAKED_FIELD_NAMES = new Set([
  "token",
  "credential",
  "cwd",
  "path",
  "persona",
  "prompt",
  "toolAllowlist",
  "allowedExecutorTools",
]);

export async function fetchCarrierSettingsState(signal?: AbortSignal): Promise<CarrierSettingsState> {
  const response = await fetch("/api/v1/plugins/terminal/carriers", { signal });
  await assertOk(response);
  return assertCarrierSettingsState(await response.json(), response.status);
}

export async function fetchCarrierSettingsOptions(signal?: AbortSignal): Promise<CarrierSettingsOptions> {
  const response = await fetch("/api/v1/plugins/terminal/carriers/options", { signal });
  await assertOk(response);
  return assertCarrierSettingsOptions(await response.json(), response.status);
}

export async function patchCarrier(carrierId: string, patch: CarrierPatch, signal?: AbortSignal): Promise<CarrierSettingsMutationResult> {
  return mutateState(`/api/v1/plugins/terminal/carriers/${encodeURIComponent(carrierId)}`, "PATCH", patch, signal);
}

export async function setCarrierTaskForceBackend(carrierId: string, cliType: string, selection: ModelSelection, signal?: AbortSignal): Promise<CarrierSettingsMutationResult> {
  return mutateState(`/api/v1/plugins/terminal/carriers/${encodeURIComponent(carrierId)}/taskforce/${encodeURIComponent(cliType)}`, "PUT", selection, signal);
}

export async function deleteCarrierTaskForceBackend(carrierId: string, cliType: string, signal?: AbortSignal): Promise<CarrierSettingsMutationResult> {
  return mutateState(`/api/v1/plugins/terminal/carriers/${encodeURIComponent(carrierId)}/taskforce/${encodeURIComponent(cliType)}`, "DELETE", {}, signal);
}

export async function deleteCarrierTaskForce(carrierId: string, signal?: AbortSignal): Promise<CarrierSettingsMutationResult> {
  return mutateState(`/api/v1/plugins/terminal/carriers/${encodeURIComponent(carrierId)}/taskforce`, "DELETE", {}, signal);
}

async function mutateState(url: string, method: string, body: unknown, signal?: AbortSignal): Promise<CarrierSettingsMutationResult> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly state?: unknown };
  if (!payload || typeof payload !== "object" || !("state" in payload)) {
    throw new ApiError(response.status, "Invalid carrier settings mutation response");
  }
  return { state: assertCarrierSettingsState(payload.state, response.status) };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new ApiError(response.status, message);
}

function assertCarrierSettingsState(value: unknown, status: number): CarrierSettingsState {
  rejectLeakedFields(value, status);
  const payload = value as Partial<CarrierSettingsState>;
  if (!payload || typeof payload.generation !== "number" || !Array.isArray(payload.carriers)) {
    throw new ApiError(status, "Invalid carrier settings state response");
  }
  return {
    generation: payload.generation,
    carriers: payload.carriers.map((carrier) => assertCarrierSettingsCarrier(carrier, status)),
  };
}

function assertCarrierSettingsOptions(value: unknown, status: number): CarrierSettingsOptions {
  rejectLeakedFields(value, status);
  const payload = value as Partial<CarrierSettingsOptions>;
  if (!payload || !Array.isArray(payload.cliTypes) || !payload.taskForceConstraints || typeof payload.taskForceConstraints.minBackends !== "number") {
    throw new ApiError(status, "Invalid carrier settings options response");
  }
  return {
    cliTypes: payload.cliTypes.map((cli) => assertCliOption(cli, status)),
    taskForceConstraints: { minBackends: payload.taskForceConstraints.minBackends },
  };
}

function assertCarrierSettingsCarrier(value: unknown, status: number): CarrierSettingsCarrier {
  const payload = value as Partial<CarrierSettingsCarrier>;
  if (
    !payload
    || typeof payload.carrierId !== "string"
    || typeof payload.displayName !== "string"
    || typeof payload.sourceDisplayName !== "string"
    || typeof payload.role !== "string"
    || typeof payload.roleDescription !== "string"
    || typeof payload.slot !== "number"
    || typeof payload.cliType !== "string"
    || typeof payload.defaultCliType !== "string"
    || typeof payload.model !== "string"
    || (payload.effort !== undefined && typeof payload.effort !== "string")
    || typeof payload.taskForceBackendCount !== "number"
    || !payload.taskforce
    || !Array.isArray(payload.taskforce.backends)
  ) {
    throw new ApiError(status, "Invalid carrier settings carrier response");
  }
  return {
    carrierId: payload.carrierId,
    displayName: payload.displayName,
    sourceDisplayName: payload.sourceDisplayName,
    role: payload.role,
    roleDescription: payload.roleDescription,
    ...(payload.category ? { category: payload.category } : {}),
    slot: payload.slot,
    cliType: payload.cliType,
    defaultCliType: payload.defaultCliType,
    model: payload.model,
    ...(payload.effort ? { effort: payload.effort } : {}),
    taskForceBackendCount: payload.taskForceBackendCount,
    taskforce: { backends: payload.taskforce.backends.map((backend) => assertTaskForceBackend(backend, status)) },
  };
}

function assertCliOption(value: unknown, status: number): CarrierSettingsCliOption {
  const payload = value as Partial<CarrierSettingsCliOption>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.displayName !== "string"
    || !Array.isArray(payload.models)
    || typeof payload.defaultModel !== "string"
  ) {
    throw new ApiError(status, "Invalid carrier settings CLI option");
  }
  return {
    id: payload.id,
    displayName: payload.displayName,
    models: payload.models.map((model) => assertModelOption(model, status)),
    defaultModel: payload.defaultModel,
  };
}

function assertModelOption(value: unknown, status: number): CarrierSettingsModelOption {
  const payload = value as Partial<CarrierSettingsModelOption>;
  if (!payload || typeof payload.modelId !== "string" || typeof payload.name !== "string") {
    throw new ApiError(status, "Invalid carrier settings model option");
  }
  if (payload.effort !== undefined && (!Array.isArray(payload.effort.levels) || typeof payload.effort.default !== "string")) {
    throw new ApiError(status, "Invalid carrier settings effort option");
  }
  return {
    modelId: payload.modelId,
    name: payload.name,
    ...(payload.effort ? { effort: { levels: payload.effort.levels.filter((level): level is string => typeof level === "string"), default: payload.effort.default } } : {}),
  };
}

function assertTaskForceBackend(value: unknown, status: number): CarrierSettingsTaskForceBackend {
  const payload = value as Partial<CarrierSettingsTaskForceBackend>;
  if (!payload || typeof payload.cliType !== "string" || typeof payload.model !== "string" || (payload.effort !== undefined && typeof payload.effort !== "string")) {
    throw new ApiError(status, "Invalid carrier settings Task Force backend");
  }
  return {
    cliType: payload.cliType,
    model: payload.model,
    ...(payload.effort ? { effort: payload.effort } : {}),
  };
}

function rejectLeakedFields(value: unknown, status: number): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, nested] of Object.entries(item)) {
      if (LEAKED_FIELD_NAMES.has(key)) throw new ApiError(status, "Carrier settings response leaked a restricted field");
      if (nested && typeof nested === "object") stack.push(nested);
    }
  }
}
