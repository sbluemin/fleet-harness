import { canonicalModelId } from "../../ai-gateway/shared/models.js";
import { readLaunchVariantGroups } from "../shared/records/launch-variants.js";
import type { ObjectivesFeatureDeps } from "./deps.js";

import { ObjectiveStoreError } from "./store.js";

/**
 * 후보 모델 목록의 출처 — Gateway `candidates` 응답과 실행 카탈로그. 둘 다 루프백 HTTP로만 읽는다.
 * 빈 후보 목록(`candidates: []`)과 조회 실패(`null` → `gateway_models_unavailable`)를 구분한다.
 */
const CATALOG_PATH = "/api/v1/objectives/records/catalog";
const QUOTA_PATH = "/api/v1/ai-gateway/quota";
const CANDIDATES_PATH = "/api/v1/ai-gateway/candidates";
const GATEWAY_MODELS_PATH = "/api/v1/ai-gateway/gateway-models";
const CATALOG_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const QUOTA_MAX_BYTES = 65_536;
const GATEWAY_MODELS_MAX_BYTES = 131_072;

export interface GatewayCandidateEntry {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly summary: string;
  readonly pressure: "ok" | "elevated" | "unknown";
  readonly resetsInSeconds?: number;
}

export interface GatewayCandidates {
  readonly candidates: readonly GatewayCandidateEntry[];
}

export type GatewayModel = GatewayCandidateEntry;
export type GatewayModels = GatewayCandidates;

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

function parseCandidateEntry(entry: unknown): GatewayCandidateEntry[] {
  if (!isRecord(entry)) return [];
  const rawModel = typeof entry.model === "string"
    ? entry.model
    : typeof entry.modelId === "string"
      ? entry.modelId
      : null;
  if (!rawModel) return [];
  const model = canonicalModelId(rawModel);
  const efforts = Array.isArray(entry.efforts)
    ? entry.efforts.filter((effort): effort is string => typeof effort === "string")
    : [];
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const pressure = entry.pressure === "ok" || entry.pressure === "elevated" ? entry.pressure : "unknown";
  const resetsInSeconds = typeof entry.resetsInSeconds === "number"
    && Number.isFinite(entry.resetsInSeconds)
    && entry.resetsInSeconds > 0
    ? Math.ceil(entry.resetsInSeconds)
    : undefined;
  return [{
    model,
    efforts,
    summary,
    pressure,
    ...(resetsInSeconds === undefined ? {} : { resetsInSeconds }),
  }];
}

export function createModelCatalog(ctx: ObjectivesFeatureDeps) {
  /** Console 의 루프백 GET — origin 이 없거나 실패·시간 초과면 null. */
  async function loopback(pathname: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    const origin = ctx.server.origin();
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

  /**
   * Gateway `candidates` 응답. 빈 배열(`candidates: []`)은 유효한 빈 후보 목록으로 돌려주고,
   * 조회 자체가 실패했거나 형식이 깨진 경우에만 `null`을 돌려준다.
   */
  async function candidates(signal: AbortSignal | undefined): Promise<GatewayCandidates | null> {
    const primary = await loopback(CANDIDATES_PATH, CATALOG_TIMEOUT_MS, signal);
    const body = isRecord(primary) ? primary : await loopback(GATEWAY_MODELS_PATH, CATALOG_TIMEOUT_MS, signal);
    if (!isRecord(body) || JSON.stringify(body).length > GATEWAY_MODELS_MAX_BYTES) return null;
    const list = Array.isArray(body.candidates)
      ? body.candidates
      : Array.isArray(body.models)
        ? body.models
        : null;
    if (!list) return null;
    return { candidates: list.flatMap(parseCandidateEntry) };
  }

  /** 사령관·지휘관의 모델 선택을 candidates로 확인한다 — 후보의 모델과 허용 강도만 받고, 조회 실패는 추측으로 통과시키지 않는다. */
  async function checkProposal(choice: { readonly model: string; readonly effort?: string | undefined }, signal: AbortSignal | undefined, loaded?: GatewayCandidates | null): Promise<{ readonly model: string; readonly effort?: string }> {
    const loadout = loaded === undefined ? await candidates(signal) : loaded;
    if (!loadout) throw new ObjectiveStoreError("gateway_models_unavailable");
    const wanted = canonicalModelId(choice.model);
    const row = loadout.candidates.find((entry) => canonicalModelId(entry.model) === wanted);
    if (!row) throw new ObjectiveStoreError("model_not_in_gateway_models", undefined, { model: choice.model });
    if (choice.effort !== undefined && !row.efforts.includes(choice.effort)) throw new ObjectiveStoreError("invalid_effort", undefined, { model: row.model, efforts: row.efforts });
    return { model: row.model, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) };
  }

  async function enabledModels(signal: AbortSignal | undefined): Promise<ReadonlySet<string> | null> {
    const loadout = await candidates(signal);
    return loadout ? new Set(loadout.candidates.map((entry) => canonicalModelId(entry.model))) : null;
  }

  async function checkCommander(choice: { readonly model: string; readonly effort?: string | undefined }, signal: AbortSignal | undefined): Promise<{ readonly model: string; readonly effort?: string }> {
    return checkProposal(choice, signal);
  }

  return { load: loadCatalog, quota: loadQuota, candidates, gatewayModels: candidates, enabledModels, checkProposal, checkCommander };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 카탈로그 묶음의 공급자 — native 는 Claude, gateway:<공급자>; 없으면 모델 id 의 접두. 한도 요약의 키와 같다. */
const providerOf = (groupId: string, model: string): string | null =>
  groupId === "native" ? "claude" : groupId.startsWith("gateway:") ? groupId.slice("gateway:".length) || null : !model.includes("--") ? "claude" : model.split("--", 1)[0] || null;
