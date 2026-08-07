import type {
  OperationLaunchVariantChip,
  OperationLaunchVariantGroup,
  OperationLaunchVariantRow,
} from "./types.js";

export function readLaunchVariantGroups(value: unknown): readonly OperationLaunchVariantGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readLaunchVariantGroup)
    .filter((group): group is OperationLaunchVariantGroup => group !== null);
}

function readLaunchVariantGroup(value: unknown): OperationLaunchVariantGroup | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !Array.isArray(value.rows)) return null;
  const rows = value.rows.map(readLaunchVariantRow).filter((row): row is OperationLaunchVariantRow => row !== null);
  return rows.length > 0 ? { id: value.id, label: value.label, rows } : null;
}

function readLaunchVariantRow(value: unknown): OperationLaunchVariantRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
  const launch = readLaunchPayload(value.launch);
  if (!launch) return null;
  const chips = Array.isArray(value.chips)
    ? value.chips.map(readLaunchVariantChip).filter((chip): chip is OperationLaunchVariantChip => chip !== null)
    : [];
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.starred === "boolean" ? { starred: value.starred } : {}),
    launch,
    ...(chips.length > 0 ? { chips } : {}),
  };
}

function readLaunchVariantChip(value: unknown): OperationLaunchVariantChip | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
  const launch = readLaunchPayload(value.launch);
  return launch ? { id: value.id, label: value.label, launch } : null;
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
