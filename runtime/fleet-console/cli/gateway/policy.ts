import {
  COMPACT_CEILING_CUSTOM_MAX,
  COMPACT_CEILING_CUSTOM_MIN,
  DEFAULT_XAI_ENDPOINT_PREFERENCE,
  GATEWAY_PROVIDERS,
  XAI_ENDPOINT_PREFERENCES,
  normalizeCompactCeiling,
  type AiGatewaySettingsStore,
  type AiGatewayStoredSettings,
  type CompactCeiling,
  type GatewayProvider,
  type XaiEndpointPreference,
} from "@dotobokuri/core-ai-gateway";

/**
 * `fleet gateway set`이 다루는 정책 축. 모델 선별은 여기 없다 — 모델 하나가 공급자·강도
 * 사다리·host-only 세 축을 함께 지녀서 `set <key> <value>`로 표현되지 않기 때문이고,
 * 그래서 모델은 인터랙티브 화면이 소유한다.
 */
export const GATEWAY_SET_KEYS = [
  "xai-endpoint",
  "compact-ceiling",
  "wire-log",
  "cursor-diagnostics",
  "provider-priority",
] as const;

export type GatewaySetKey = typeof GATEWAY_SET_KEYS[number];

export const GATEWAY_SET_KEY_SYNTAX: Readonly<Record<GatewaySetKey, string>> = Object.freeze({
  "xai-endpoint": "direct | cli-proxy",
  "compact-ceiling": `auto | early | late | ${COMPACT_CEILING_CUSTOM_MIN}–${COMPACT_CEILING_CUSTOM_MAX}`,
  "wire-log": "on | off | auto",
  "cursor-diagnostics": "on | off",
  "provider-priority": "comma-separated providers, or `none`",
});

export type GatewaySetResult =
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly message: string };

export function isGatewaySetKey(value: string | undefined): value is GatewaySetKey {
  return value !== undefined && (GATEWAY_SET_KEYS as readonly string[]).includes(value);
}

export function applyGatewaySetting(
  store: AiGatewaySettingsStore,
  key: GatewaySetKey,
  rawValue: string | undefined,
): GatewaySetResult {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return invalid(key, rawValue);
  }
  const value = rawValue.trim();

  if (key === "xai-endpoint") {
    if (!XAI_ENDPOINT_PREFERENCES.includes(value as XaiEndpointPreference)) return invalid(key, value);
    store.writeXaiEndpoint(value as XaiEndpointPreference);
    return { ok: true, summary: `xai-endpoint = ${value}` };
  }

  if (key === "compact-ceiling") {
    if (value === "auto") {
      store.writeCompactCeiling(undefined);
      return { ok: true, summary: "compact-ceiling = auto" };
    }
    const ceiling = normalizeCompactCeiling(/^\d+$/.test(value) ? Number(value) : value);
    if (ceiling === undefined) return invalid(key, value);
    store.writeCompactCeiling(ceiling);
    return { ok: true, summary: `compact-ceiling = ${ceiling}` };
  }

  if (key === "wire-log") {
    const enabled = parseToggle(value, { allowAuto: true });
    if (enabled === "invalid") return invalid(key, value);
    store.writeWireLogEnabled(enabled);
    return { ok: true, summary: `wire-log = ${enabled === undefined ? "auto" : enabled ? "on" : "off"}` };
  }

  if (key === "cursor-diagnostics") {
    const enabled = parseToggle(value, { allowAuto: false });
    if (enabled === "invalid" || enabled === undefined) return invalid(key, value);
    store.writeCursorDiagnosticsEnabled(enabled);
    return { ok: true, summary: `cursor-diagnostics = ${enabled ? "on" : "off"}` };
  }

  const priority = parseProviderPriority(value);
  if (priority === "invalid") return invalid(key, value);
  writeProviderPriority(store, priority);
  return {
    ok: true,
    summary: `provider-priority = ${priority.length === 0 ? "none" : priority.join(" → ")}`,
  };
}

/**
 * 우선순위만 바꾸는 저장. `write`는 넘긴 값으로 models 키를 통째로 덮으므로, 현재 선별을
 * 함께 실어야 한다 — 싣지 않으면 우선순위 한 번 바꾼 대가로 노출 모델이 전부 사라진다.
 */
export function writeProviderPriority(
  store: AiGatewaySettingsStore,
  priority: readonly GatewayProvider[],
): AiGatewayStoredSettings {
  const current = store.read();
  return store.write({
    ...(current.models?.length ? { models: current.models } : {}),
    providerPriority: priority,
  });
}

export function parseProviderPriority(
  value: string,
): readonly GatewayProvider[] | "invalid" {
  if (value === "none") return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) return "invalid";
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!(GATEWAY_PROVIDERS as readonly string[]).includes(entry)) return "invalid";
    if (seen.has(entry)) return "invalid";
    seen.add(entry);
  }
  return entries as readonly GatewayProvider[];
}

/** 저장된 정책을 사람이 읽는 값으로. status와 인터랙티브 요약이 같은 어휘를 쓰게 한다. */
export function describeGatewayPolicy(settings: AiGatewayStoredSettings): Readonly<Record<GatewaySetKey, string>> {
  return {
    "xai-endpoint": settings.xaiEndpoint ?? `${DEFAULT_XAI_ENDPOINT_PREFERENCE} (default)`,
    "compact-ceiling": describeCompactCeiling(settings.compactCeiling),
    "wire-log": settings.wireLogEnabled === undefined
      ? "auto (env)"
      : settings.wireLogEnabled ? "on" : "off",
    "cursor-diagnostics": settings.cursorDiagnosticsEnabled === true ? "on" : "off",
    "provider-priority": settings.providerPriority?.length
      ? settings.providerPriority.join(" → ")
      : "none",
  };
}

function describeCompactCeiling(ceiling: CompactCeiling | undefined): string {
  if (ceiling === undefined) return "auto";
  return typeof ceiling === "number" ? `${ceiling}%` : ceiling;
}

function parseToggle(
  value: string,
  options: { readonly allowAuto: boolean },
): boolean | undefined | "invalid" {
  if (value === "on") return true;
  if (value === "off") return false;
  if (options.allowAuto && value === "auto") return undefined;
  return "invalid";
}

function invalid(key: GatewaySetKey, value: string | undefined): GatewaySetResult {
  const shown = value === undefined || value.trim().length === 0 ? "(missing)" : value;
  return {
    ok: false,
    message: `Invalid value for ${key}: ${shown}\nExpected ${GATEWAY_SET_KEY_SYNTAX[key]}.`,
  };
}
