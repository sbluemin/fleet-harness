import { canonicalModelId } from "@fleet-console/sdk/models";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { ObjectiveStoreError } from "./store.js";

/**
 * 구성원 모델 목록의 출처 — Console 이 내놓는 실행 카탈로그와 Gateway 한도 요약. 둘 다 루프백 HTTP 로만 읽는다.
 * 모델 목록 화면(console_objectives models)은 실행 카탈로그를, 지휘관의 구성원 모델 제안(fleet-objectives models·plan·enlist)은
 * 라우팅 판단이 보는 gateway_models 를 읽는다 — 제안은 그 판단의 입력이므로 판단과 같은 후보로 확인한다.
 */
const CATALOG_PATH = "/api/v1/operations/catalog";
const QUOTA_PATH = "/api/v1/ai-gateway/quota";
const CATALOG_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const QUOTA_MAX_BYTES = 65_536;
const GATEWAY_MODELS_PATH = "/api/v1/ai-gateway/gateway-models";
const GATEWAY_MODELS_MAX_BYTES = 131_072;

/** 라우팅 판단이 보는 후보 한 줄(gateway_models.models). modelId 가 판단과 제안이 같이 쓰는 이름이다. */
export interface GatewayModel { readonly modelId: string; readonly efforts: readonly string[]; readonly [key: string]: unknown }
export interface GatewayModels { readonly routing: unknown; readonly models: readonly GatewayModel[]; readonly [key: string]: unknown }

export interface CatalogModel {
  readonly model: string;
  readonly label: string;
  readonly provider: string | null;
  readonly efforts: readonly string[];
  readonly available: boolean;
  readonly reason?: string;
  readonly quotaScope?: string;
  readonly quotaPool?: string;
}

export type ModelCatalog = ReturnType<typeof createModelCatalog>;

export function createModelCatalog(ctx: FleetPluginServerContext) {
  /** Console 의 루프백 GET — origin 이 없거나 실패·시간 초과면 null. */
  async function loopback(pathname: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    const origin = ctx.host.server.origin();
    if (!origin) return null;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${origin}${pathname}`, { method: "GET", headers: { origin, accept: "application/json" }, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) return null;
      const body = await response.text();
      return body.length > 0 ? JSON.parse(body) as unknown : null;
    } catch { return null; }
  }

  /** 실행 카탈로그의 모델 행 — 화면의 모델 메뉴(loadLaunchGroups)와 같은 해석이다: 변형 행의 launch.model, 강도는 그 행의 칩. 처음 나온 모델이 이긴다. */
  async function loadCatalog(signal: AbortSignal | undefined): Promise<CatalogModel[] | null> {
    const body = await loopback(CATALOG_PATH, CATALOG_TIMEOUT_MS, signal);
    if (!isRecord(body) || !Array.isArray(body.plugins)) return null;
    const rows: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const plugin of body.plugins) {
      if (!isRecord(plugin) || !Array.isArray(plugin.kinds)) continue;
      for (const kind of plugin.kinds) {
        if (!isRecord(kind)) continue;
        const available = kind.disabled !== true;
        const reason = !available && typeof kind.disabledReason === "string" ? kind.disabledReason.slice(0, 200) : undefined;
        for (const group of readLaunchVariantGroups(kind.variants)) {
          for (const row of group.rows) {
            const model = row.launch.model;
            if (!model || seen.has(model)) continue;
            seen.add(model);
            const efforts = (row.chips ?? []).flatMap((chip) => (chip.launch.effort ? [chip.launch.effort] : []));
            rows.push({ model, label: row.label, provider: providerOf(group.id, model), efforts, available, ...(reason ? { reason } : {}), ...(row.quotaScope ? { quotaScope: row.quotaScope } : {}), ...(row.quotaPool ? { quotaPool: row.quotaPool } : {}) });
          }
        }
      }
    }
    return rows;
  }

  /** Gateway 한도 요약(공급자별 창의 사용률) — 읽지 못하면 null 이고 목록은 그대로 낸다. */
  async function loadQuota(signal: AbortSignal | undefined) {
    const body = await loopback(`${QUOTA_PATH}?stale=1`, QUOTA_TIMEOUT_MS, signal);
    const providers = isRecord(body) && isRecord(body.providers) ? body.providers : null;
    if (!providers || JSON.stringify(providers).length > QUOTA_MAX_BYTES) return null;
    const quota: Record<string, { status: string; windows?: { id: string; label?: string; usedPercent: number; resetsAt?: number; scope?: string; isAggregate?: boolean }[] }> = {};
    for (const [provider, entry] of Object.entries(providers)) {
      if (!isRecord(entry) || typeof entry.status !== "string") continue;
      const windows = Array.isArray(entry.windows) ? entry.windows.flatMap((window) => isRecord(window) && typeof window.id === "string" && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
        ? [{ id: window.id, ...(typeof window.label === "string" ? { label: window.label.slice(0, 80) } : {}), usedPercent: window.usedPercent, ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}), ...(typeof window.scope === "string" ? { scope: window.scope } : {}), ...(typeof window.isAggregate === "boolean" ? { isAggregate: window.isAggregate } : {}) }]
        : []) : [];
      quota[provider] = { status: entry.status, ...(windows.length ? { windows } : {}) };
    }
    return Object.keys(quota).length ? quota : null;
  }

  /** 라우팅 판단이 보는 gateway_models 그대로 — 읽지 못하면 null. */
  async function gatewayModels(signal: AbortSignal | undefined): Promise<GatewayModels | null> {
    const body = await loopback(GATEWAY_MODELS_PATH, CATALOG_TIMEOUT_MS, signal);
    if (!isRecord(body) || !Array.isArray(body.models) || JSON.stringify(body).length > GATEWAY_MODELS_MAX_BYTES) return null;
    const models = body.models.flatMap((entry): GatewayModel[] => isRecord(entry) && typeof entry.modelId === "string"
      ? [{ ...entry, modelId: entry.modelId, efforts: Array.isArray(entry.efforts) ? entry.efforts.filter((effort): effort is string => typeof effort === "string") : [] }] : []);
    return { ...body, routing: body.routing ?? null, models };
  }

  /** 지휘관의 모델 제안을 gateway_models 로 확인한다 — 그 후보의 모델과 강도만 받고, 목록을 읽지 못하면 추측으로 통과시키지 않는다. */
  async function checkProposal(choice: { readonly model: string; readonly effort?: string | undefined }, signal: AbortSignal | undefined, loaded?: GatewayModels | null): Promise<{ readonly model: string; readonly effort?: string }> {
    const loadout = loaded === undefined ? await gatewayModels(signal) : loaded;
    if (!loadout) throw new ObjectiveStoreError("gateway_models_unavailable");
    const wanted = canonicalModelId(choice.model);
    const row = loadout.models.find((entry) => canonicalModelId(entry.modelId) === wanted);
    if (!row) throw new ObjectiveStoreError("model_not_in_gateway_models", undefined, { model: choice.model });
    if (choice.effort !== undefined && !row.efforts.includes(choice.effort)) throw new ObjectiveStoreError("invalid_effort", undefined, { model: row.modelId, efforts: row.efforts });
    return { model: row.modelId, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) };
  }

  return { load: loadCatalog, quota: loadQuota, gatewayModels, checkProposal };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 카탈로그 묶음의 공급자 — native 는 Claude, gateway:<공급자>; 없으면 모델 id 의 접두. 한도 요약의 키와 같다. */
const providerOf = (groupId: string, model: string): string | null =>
  groupId === "native" ? "claude" : groupId.startsWith("gateway:") ? groupId.slice("gateway:".length) || null : !model.includes("--") ? "claude" : model.split("--", 1)[0] || null;
