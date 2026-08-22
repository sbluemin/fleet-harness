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

// 표시용 퍼센트. core-ai-gateway는 이 둘을 내부 상수로 두므로 소비 계층이 미러링한다 —
// Console의 AI Gateway 화면도 같은 값을 자기 파일에 들고 있다(terminal/client/agent/index.tsx).
const COMPACT_CEILING_EARLY_PERCENT = 88;
const COMPACT_CEILING_LATE_PERCENT = 97;

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

/**
 * Spend priority 화면에서 다음 자리의 기본 선택. 저장된 순서가 아직 남아 있으면 그 값을,
 * 소진되면 종료 항목("")을 고른다 — 기본값이 없으면 커서가 남은 공급자 첫 줄에 놓이고,
 * 엔터만 눌러 지나가는 사용자가 없던 순위를 하나씩 만들어 낸다.
 */
export function nextPriorityDefault(
  stored: readonly GatewayProvider[] | undefined,
  ordered: readonly GatewayProvider[],
  remaining: readonly GatewayProvider[],
): GatewayProvider | "" {
  const suggested = (stored ?? [])[ordered.length];
  return suggested !== undefined && remaining.includes(suggested) ? suggested : "";
}

/**
 * 인터랙티브 Policy 화면이 고르는 compact 상한. `custom`은 저장된 퍼센트가 있을 때만 나타나며
 * 그 값을 그대로 유지한다 — 이 축을 건드리지 않고 지나가려는 사용자가 화면을 지나갔다는 이유로
 * `set compact-ceiling 82`를 잃어서는 안 된다.
 */
export type CompactCeilingChoice = "auto" | "early" | "late" | "custom";

export interface CompactCeilingChoices {
  readonly options: readonly { readonly value: CompactCeilingChoice; readonly label: string; readonly hint: string }[];
  readonly initialValue: CompactCeilingChoice;
}

export function buildCompactCeilingChoices(stored: CompactCeiling | undefined): CompactCeilingChoices {
  const custom = typeof stored === "number" ? stored : undefined;
  const initialValue: CompactCeilingChoice = custom !== undefined
    ? "custom"
    : stored === "early" || stored === "late" ? stored : "auto";
  return {
    options: [
      { value: "auto", label: "Auto", hint: "context window - 16k" },
      { value: "early", label: "Early", hint: `${COMPACT_CEILING_EARLY_PERCENT}% of the window` },
      { value: "late", label: "Late", hint: `${COMPACT_CEILING_LATE_PERCENT}% of the window` },
      ...(custom === undefined
        ? []
        : [{ value: "custom" as const, label: `Custom (${custom}%)`, hint: "keep the stored percent" }]),
    ],
    initialValue,
  };
}

/** 고른 항목을 저장 값으로. `custom`은 저장된 퍼센트를 되돌려 그 축을 그대로 둔다. */
export function resolveCompactCeilingChoice(
  choice: CompactCeilingChoice,
  stored: CompactCeiling | undefined,
): CompactCeiling | undefined {
  if (choice === "custom") return typeof stored === "number" ? stored : undefined;
  return choice === "auto" ? undefined : choice;
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
