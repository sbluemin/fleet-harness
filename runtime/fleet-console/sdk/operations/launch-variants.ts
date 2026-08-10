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
  // 축은 칩이 놓인 자리를 말한다 — 칩이 없으면 말할 자리도 없다.
  const effortAxis = Array.isArray(value.effortAxis)
    ? value.effortAxis.filter((rung): rung is string => typeof rung === "string" && rung.length > 0)
    : [];
  const effortExpansion = readEffortExpansion(value.effortExpansion, effortAxis);
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.starred === "boolean" ? { starred: value.starred } : {}),
    launch,
    ...(chips.length > 0 ? { chips } : {}),
    ...(chips.length > 0 && effortAxis.length > 0 ? { effortAxis } : {}),
    ...(chips.length > 0 && effortExpansion ? { effortExpansion } : {}),
  };
}

/**
 * 펼침 경계는 축 위의 좌표라서 축 없이는 뜻이 없다. `after`가 축에 없거나 그 뒤에 남는 단이 없으면
 * 경계를 세울 수 없으므로 통째로 버린다 — 반쯤 살려 두면 표면이 평범한 레일의 천장을 잘못 잡는다.
 */
function readEffortExpansion(
  value: unknown,
  effortAxis: readonly string[],
): OperationLaunchVariantRow["effortExpansion"] | null {
  if (!isRecord(value) || typeof value.after !== "string") return null;
  const boundary = effortAxis.indexOf(value.after);
  if (boundary < 0 || boundary === effortAxis.length - 1) return null;
  const declared = Array.isArray(value.rungs)
    ? value.rungs.filter((rung): rung is string => typeof rung === "string" && rung.length > 0)
    : [];
  const tail = effortAxis.slice(boundary + 1);
  // 공표된 순서가 축의 꼬리와 어긋나면 축을 따른다. 축이 자리의 유일한 근거다.
  const rungs = declared.length > 0 && declared.every((rung) => tail.includes(rung)) ? declared : tail;
  return rungs.length > 0 ? { after: value.after, rungs } : null;
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
