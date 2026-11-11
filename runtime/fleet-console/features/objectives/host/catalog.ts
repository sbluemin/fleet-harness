import { canonicalModelId } from "../../ai-gateway/shared/models.js";
import { readLaunchVariantGroups } from "../shared/records/launch-variants.js";
import type { ObjectivesFeatureDeps } from "./deps.js";

import { ObjectiveStoreError } from "./store.js";

/**
 * 모델 선택 확인의 출처 — Gateway `enabled-models` 응답과 실행 카탈로그. 둘 다 루프백 HTTP로 읽는다.
 * 빈 목록(`models: []`)과 조회 실패(`null` → `gateway_models_unavailable`)를 구분한다.
 */
const CATALOG_PATH = "/api/v1/objectives/records/catalog";
const ENABLED_MODELS_PATH = "/api/v1/ai-gateway/enabled-models";
const CATALOG_TIMEOUT_MS = 5_000;
const ENABLED_MODELS_MAX_BYTES = 131_072;

export interface EnabledModelEntry {
  readonly model: string;
  readonly fast: boolean;
  readonly efforts: readonly string[];
  readonly summary: string;
}

export interface EnabledModels {
  readonly models: readonly EnabledModelEntry[];
}

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

function parseEnabledEntry(entry: unknown): EnabledModelEntry[] {
  if (!isRecord(entry)) return [];
  if (typeof entry.model !== "string" || entry.model === "") return [];
  const model = canonicalModelId(entry.model);
  const efforts = Array.isArray(entry.efforts)
    ? entry.efforts.filter((effort): effort is string => typeof effort === "string")
    : [];
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  return [{ model, fast: entry.fast === true, efforts, summary }];
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

  /**
   * Gateway `enabled-models` 응답. 빈 배열(`models: []`)은 유효한 빈 목록으로 돌려주고,
   * 조회 자체가 실패했거나 형식이 깨진 경우에만 `null`을 돌려준다.
   */
  async function enabledModels(signal: AbortSignal | undefined): Promise<EnabledModels | null> {
    const body = await loopback(ENABLED_MODELS_PATH, CATALOG_TIMEOUT_MS, signal);
    if (!isRecord(body) || !Array.isArray(body.models) || JSON.stringify(body).length > ENABLED_MODELS_MAX_BYTES) return null;
    return { models: body.models.flatMap(parseEnabledEntry) };
  }

  /** 넘긴 모델·강도를 enabled-models로 확인한다. 조회 실패는 추측으로 통과시키지 않는다. */
  async function checkProposal(choice: { readonly model: string; readonly effort?: string | undefined }, signal: AbortSignal | undefined, loaded?: EnabledModels | null): Promise<{ readonly model: string; readonly effort?: string }> {
    const loadout = loaded === undefined ? await enabledModels(signal) : loaded;
    if (!loadout) throw new ObjectiveStoreError("gateway_models_unavailable", undefined, { hint: "fleet-ai-gateway models could not be read; retry." });
    const wanted = canonicalModelId(choice.model);
    const row = loadout.models.find((entry) => canonicalModelId(entry.model) === wanted);
    if (!row) throw new ObjectiveStoreError("model_not_in_gateway_models", undefined, { model: choice.model, models: loadout.models, hint: "Choose one of the supplied models." });
    if (choice.effort !== undefined && !row.efforts.includes(choice.effort)) throw new ObjectiveStoreError("invalid_effort", undefined, { model: row.model, efforts: row.efforts });
    return { model: row.model, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) };
  }

  /**
   * 사령관이 넘긴 지휘관 모델 — 실행 카탈로그에서 고를 수 있고 enabled-models에 있는 모델만 받는다.
   * 어느 목록이든 읽지 못하면 추측으로 통과시키지 않는다. 사람이 직접 고른 지휘관은 이 확인을 거치지 않는다.
   */
  async function checkCommander(choice: { readonly model: string; readonly effort?: string | undefined }, signal: AbortSignal | undefined): Promise<{ readonly model: string; readonly effort?: string }> {
    const [catalog, loaded] = await Promise.all([loadCatalog(signal), enabledModels(signal)]);
    availableIn(catalog, choice.model);
    return checkProposal(choice, signal, loaded);
  }

  /** 사람이 명시한 모델(사령관의 지휘관 설정)은 enabled-models 로 막지 않고 실행 카탈로그 가용성만 본다. */
  async function checkAvailable(choice: { readonly model: string }, signal: AbortSignal | undefined): Promise<void> {
    availableIn(await loadCatalog(signal), choice.model);
  }

  return { enabledModels, checkProposal, checkCommander, checkAvailable };
}

function availableIn(catalog: readonly CatalogModel[] | null, model: string): void {
  if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
  const wanted = canonicalModelId(model);
  const row = catalog.find((entry) => canonicalModelId(entry.model) === wanted);
  if (!row || !row.available) throw new ObjectiveStoreError("model_not_in_catalog", undefined, { model, ...(row?.reason ? { reason: row.reason } : {}) });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 카탈로그 묶음의 공급자 — native 는 Claude, gateway:<공급자>; 없으면 모델 id 의 접두. 한도 요약의 키와 같다. */
const providerOf = (groupId: string, model: string): string | null =>
  groupId === "native" ? "claude" : groupId.startsWith("gateway:") ? groupId.slice("gateway:".length) || null : !model.includes("--") ? "claude" : model.split("--", 1)[0] || null;
