import {
  buildAiGatewayCatalog,
  GATEWAY_PROVIDER_NAMES,
  type AiGatewayCatalogModel,
  type AiGatewayStoredModel,
  type AiGatewayStoredSettings,
  type GatewayProvider,
} from "@dotobokuri/core-ai-gateway";

/** 인터랙티브 화면이 고르는 한 줄. 라벨·힌트는 프롬프트가 그대로 쓴다. */
export interface GatewayModelChoice {
  readonly id: string;
  readonly provider: GatewayProvider;
  readonly label: string;
  readonly hint: string;
}

export interface GatewayModelChoices {
  /** 공급자 표시명 → 그 공급자의 모델들. 카탈로그 순서를 그대로 유지한다. */
  readonly groups: Readonly<Record<string, readonly GatewayModelChoice[]>>;
  readonly selectedIds: readonly string[];
}

export function buildGatewayModelChoices(settings: AiGatewayStoredSettings): GatewayModelChoices {
  const catalog = buildAiGatewayCatalog();
  const groups: Record<string, readonly GatewayModelChoice[]> = {};
  for (const provider of catalog.providers) {
    if (provider.models.length === 0) continue;
    groups[GATEWAY_PROVIDER_NAMES[provider.id]] = provider.models.map((model) => ({
      id: model.id,
      provider: provider.id,
      label: model.name,
      hint: describeCatalogModel(model),
    }));
  }
  const catalogIds = new Set(catalog.providers.flatMap((provider) => provider.models.map((model) => model.id)));
  return {
    groups,
    selectedIds: (settings.models ?? [])
      .map((entry) => entry.id)
      .filter((id) => catalogIds.has(id)),
  };
}

/**
 * 새 노출 집합을 저장 형태로 바꾼다. 이미 있던 모델의 강도 선택과 host-only 표식은
 * 그대로 옮겨 온다 — 모델 하나를 더 켜는 일이 나머지 모델의 세부 설정을 지우면 안 된다.
 */
export function toStoredModels(
  selectedIds: readonly string[],
  previous: readonly AiGatewayStoredModel[] | undefined,
): readonly AiGatewayStoredModel[] {
  const carried = new Map((previous ?? []).map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const models: AiGatewayStoredModel[] = [];
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(carried.get(id) ?? { id });
  }
  return models;
}

/** 한 모델의 강도 선택만 교체한다. 빈 선택은 "사다리 전체"를 뜻해 키를 지운다. */
export function withModelEfforts(
  models: readonly AiGatewayStoredModel[],
  id: string,
  efforts: readonly string[],
): readonly AiGatewayStoredModel[] {
  return models.map((entry) => {
    if (entry.id !== id) return entry;
    const rest = { id: entry.id, ...(entry.hostOnly === true ? { hostOnly: true } : {}) };
    return efforts.length === 0 ? rest : { ...rest, efforts };
  });
}

/** 한 모델의 host-only 표식만 뒤집는다. 저장 정규형은 true만 남긴다. */
export function withModelHostOnly(
  models: readonly AiGatewayStoredModel[],
  id: string,
  hostOnly: boolean,
): readonly AiGatewayStoredModel[] {
  return models.map((entry) => {
    if (entry.id !== id) return entry;
    const rest = { id: entry.id, ...(entry.efforts?.length ? { efforts: entry.efforts } : {}) };
    return hostOnly ? { ...rest, hostOnly: true } : rest;
  });
}

/** 카탈로그가 이 모델에 허용하는 강도 사다리. 없으면 빈 배열. */
export function effortLadderFor(id: string): readonly string[] {
  for (const provider of buildAiGatewayCatalog().providers) {
    const model = provider.models.find((entry) => entry.id === id);
    if (model) return model.effort?.levels ?? [];
  }
  return [];
}

function describeCatalogModel(model: AiGatewayCatalogModel): string {
  const axes = [
    model.capabilityClass ?? undefined,
    model.oneMillion ? "1M" : undefined,
    model.maxMode ? "max mode" : undefined,
    model.fast ? "fast" : undefined,
    model.effort ? `effort ${model.effort.levels.join("·")}` : undefined,
  ].filter((axis): axis is string => axis !== undefined);
  return axes.join(" · ");
}
