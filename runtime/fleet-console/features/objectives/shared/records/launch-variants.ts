import type { ObjectiveLaunchVariantChip, ObjectiveLaunchVariantGroup, ObjectiveLaunchVariantRow } from "./types.js";

export function readLaunchVariantGroups(value: unknown): readonly ObjectiveLaunchVariantGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readLaunchVariantGroup)
    .filter((group): group is ObjectiveLaunchVariantGroup => group !== null);
}

function readLaunchVariantGroup(value: unknown): ObjectiveLaunchVariantGroup | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !Array.isArray(value.rows)) return null;
  const rows = value.rows.map(readLaunchVariantRow).filter((row): row is ObjectiveLaunchVariantRow => row !== null);
  return rows.length > 0 ? { id: value.id, label: value.label, rows } : null;
}

function readLaunchVariantRow(value: unknown): ObjectiveLaunchVariantRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
  const launch = readLaunchPayload(value.launch);
  if (!launch) return null;
  const chips = Array.isArray(value.chips)
    ? value.chips.map(readLaunchVariantChip).filter((chip): chip is ObjectiveLaunchVariantChip => chip !== null)
    : [];
  // 축은 칩이 놓인 자리를 말한다 — 칩이 없으면 말할 자리도 없다.
  const effortAxis = Array.isArray(value.effortAxis)
    ? value.effortAxis.filter((rung): rung is string => typeof rung === "string" && rung.length > 0)
    : [];
  const gatedEfforts = Array.isArray(value.gatedEfforts)
    ? value.gatedEfforts.filter((effort): effort is string => typeof effort === "string" && effort.length > 0)
    : [];
  const quotaScopes = Array.isArray(value.quotaScopes)
    ? value.quotaScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : typeof value.quotaScope === "string" && value.quotaScope.length > 0
      ? [value.quotaScope]
      : [];
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.starred === "boolean" ? { starred: value.starred } : {}),
    launch,
    ...(typeof value.quotaPool === "string" && value.quotaPool.length > 0 ? { quotaPool: value.quotaPool } : {}),
    ...(quotaScopes.length > 0 ? { quotaScopes } : {}),
    ...(value.fastSupported === true ? { fastSupported: true } : {}),
    ...(typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow > 0
      ? { contextWindow: value.contextWindow }
      : {}),
    ...(chips.length > 0 ? { chips } : {}),
    ...(chips.length > 0 && effortAxis.length > 0 ? {
      effortAxis,
      ...(gatedEfforts.length > 0 ? { gatedEfforts } : {}),
    } : {}),
  };
}

function readLaunchVariantChip(value: unknown): ObjectiveLaunchVariantChip | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
  const launch = readLaunchPayload(value.launch);
  if (!launch) return null;
  const intelligence = typeof value.intelligence === "number" && Number.isFinite(value.intelligence) ? value.intelligence : undefined;
  return { id: value.id, label: value.label, launch, ...(intelligence !== undefined ? { intelligence } : {}) };
}

function readLaunchPayload(value: unknown): Readonly<Record<string, string>> | null {
  if (!isPlainRecord(value)) return null;
  const launch = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.keys(launch).length > 0 ? launch : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
