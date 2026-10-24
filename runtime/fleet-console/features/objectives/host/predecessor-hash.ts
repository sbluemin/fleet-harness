import { createHash } from "node:crypto";
import { sanitizeDurableConsoleState, sanitizeObjectiveRecord } from "../../workspace/host/durable-state.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const bag = (value: unknown): Record<string, unknown> => record(value) ? value : {};
/** 직전 v6 저널의 체크섬만 재현한다. 이 모양은 새 저장소나 API로 내보내지 않는다. */
export function predecessorStateHash(value: unknown): string {
  const raw = bag(value);
  const normalized = sanitizeDurableConsoleState(raw);
  // 구 저널 체크섬에만 쓰는 v6 표현이다. 현 명부 reader/새 쓰기에 alias를 되살리지 않는다.
  const previousTheater = (value: object, source: unknown) => {
    const alias = bag(source).alias;
    const trimmed = typeof alias === "string" ? alias.trim() : "";
    // eslint-disable-next-line no-control-regex
    return trimmed && [...trimmed].length <= 40 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(trimmed) ? { ...value, alias: trimmed } : value;
  };
  function previousNode(value: unknown): Record<string, unknown> | null {
    const raw = bag(value), node = sanitizeObjectiveRecord(raw);
    if (!node) return null;
    const geometry = bag(raw.geometry);
    const hasGeometry = ["x", "y", "width", "height", "zIndex"].every((key) => typeof geometry[key] === "number" && Number.isFinite(geometry[key]));
    const children = Array.isArray(raw.childSessions) ? raw.childSessions.flatMap((value) => {
      const child = bag(value), ts = bag(child.ts);
      return typeof child.id === "string" && child.id && child.id !== node.id && typeof ts.createdAt === "number" && typeof ts.updatedAt === "number"
        ? [{ id: child.id, payload: bag(child.payload), ts: { createdAt: ts.createdAt, updatedAt: ts.updatedAt } }] : [];
    }) : [];
    const pluginId = raw.pluginId === "agent" || raw.pluginId === "shell" ? "terminal" : raw.pluginId;
    return { id: node.id, theaterId: node.theaterId, type: raw.type,
      pluginId: pluginId === "terminal" && raw.type === "agent" ? null : pluginId,
      title: node.title, payload: bag(raw.payload), geometry: hasGeometry ? Object.fromEntries(["x", "y", "width", "height", "zIndex"].map((key) => [key, geometry[key]])) : null,
      ...(node.accent ? { accent: node.accent } : {}), ...(node.groupId !== undefined ? { groupId: node.groupId } : {}), ...(node.order !== undefined ? { order: node.order } : {}),
      ...(children.length ? { childSessions: children } : {}), ts: node.ts,
    };
  }
  const rows = (value: unknown) => Array.isArray(value) ? value.map(previousNode).filter((row) => row !== null) : [];
  const previous = { version: 6, ...(normalized.revision !== undefined ? { revision: normalized.revision } : {}), theaters: normalized.theaters.map((theater) => previousTheater(theater, Array.isArray(raw.theaters) ? raw.theaters.find((row) => bag(row).id === theater.id) : null)),
    operations: rows(raw.operations), groups: normalized.groups ?? [],
    deletionTombstones: (normalized.deletionTombstones ?? []).map((entry) => {
      const source = Array.isArray(raw.deletionTombstones) ? bag(raw.deletionTombstones.find((value) => bag(value).deletionId === entry.deletionId)) : {};
      const base = { deletionId: entry.deletionId, targetId: entry.targetId, deletedAt: entry.deletedAt, expiresAt: entry.expiresAt, ...(entry.archived ? { archived: entry.archived } : {}) };
      return entry.kind === "theater" ? { ...base, kind: "theater", theater: previousTheater(entry.theater, source.theater), operations: rows(source.operations), groups: entry.groups }
        : { ...base, kind: "operation", operation: previousNode(source.operation), ...(entry.descendants?.length ? { descendants: rows(source.descendants) } : {}) };
    }),
  };
  return createHash("sha256").update(JSON.stringify(previous, (_key, value: unknown) => record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}
