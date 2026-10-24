import path from "node:path";
import type { ObjectiveRecord } from "./records/objective-records-domain.js";
import { readObjectiveLaunchSource } from "../shared/records/launch-source.js";
import type { StoredObjective } from "../shared/types.js";

/** 소유는 디렉터리, 위치는 목표의 cwd가 나타낸다. */
export interface ObjectiveDocument extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly ts: { readonly createdAt: number; readonly updatedAt: number };
  readonly pending?: true;
}
export interface ObjectiveDocumentContext {
  readonly commodoreId: string;
  /** 자기 cwd가 없던 옛 목표의 마지막 복구 근거. 새 목표 생성에는 쓰지 않는다. */
  readonly legacyTheaterId: string;
  readonly legacyCwd: string;
  readonly theaterIdOf: (cwd: string) => string;
}
const executionKeys = ["cwd", "session", "chatMode", "chatBorn", "dormantBorn", "restoredDormant", "subagentSpawn", "launchedBy", "consoleUse", "computerUse", "labelSource", "providerTitle", "objectiveLanguage"] as const;
const sessionKeys = ["harness", "model", "effort", "sessionName", "id", "transcriptPath", "source", "capturedAt", "disableSubagents", "disableAutoMemory"] as const;
const surfaceKeys = ["title", "groupId", "order", "accent", "ts", "sessions", ...executionKeys];
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
function execution(payload: Record<string, unknown>): Record<string, unknown> {
  const out = pick(payload, executionKeys);
  if (object(out.session)) out.session = pick(out.session, sessionKeys);
  if (out.launchedBy === null) delete out.launchedBy;
  else if (out.launchedBy !== undefined) {
    const source = readObjectiveLaunchSource(out.launchedBy);
    if (!source) throw new Error("invalid_objective_launch_source");
    out.launchedBy = source;
  }
  for (const key of ["consoleUse", "computerUse"] as const) if (object(out[key])) out[key] = pick(out[key], ["enabled", "language"]);
  if (object(out.providerTitle)) out.providerTitle = pick(out.providerTitle, ["source"]);
  return out;
}
/** 옛 행위자만 파일 소유자로 복구한다. 사용자 객체의 동명 필드는 지우지 않는다. */
function actors(value: unknown, context: ObjectiveDocumentContext): unknown {
  if (Array.isArray(value)) return value.map((item) => actors(item, context));
  if (!object(value)) return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, actors(item, context)]));
  if (out.kind === "commodore") {
    if (out.commodoreId !== undefined && out.commodoreId !== context.commodoreId) throw new Error("objective_actor_owner_mismatch");
    if (out.theaterId !== undefined && out.theaterId !== context.legacyTheaterId) throw new Error("objective_actor_owner_mismatch");
    delete out.theaterId;
    out.commodoreId = context.commodoreId;
  }
  if (typeof out.objectiveId === "string" && out.objectiveId.startsWith("commodore:")) {
    const id = out.objectiveId.slice("commodore:".length);
    if (id !== context.commodoreId && id !== context.legacyTheaterId) throw new Error("objective_actor_owner_mismatch");
    out.objectiveId = `commodore:${context.commodoreId}`;
  }
  return out;
}
export function normalizeObjectiveDocument(doc: ObjectiveDocument, context: ObjectiveDocumentContext): ObjectiveDocument {
  const cwd = doc.cwd === undefined ? context.legacyCwd : doc.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) throw new Error("objective_location_unavailable");
  return { ...actors(doc, context) as ObjectiveDocument, cwd };
}
export function documentFromBoard(board: StoredObjective, previous?: ObjectiveDocument): ObjectiveDocument {
  const { commodoreId: _owner, theaterId: _location, ...fields } = board;
  const result: Record<string, unknown> = { ...fields };
  // 보드는 완전한 스냅샷이다. 실행이 소유하는 필드만 이전 문서에서 보존한다.
  if (previous && (!board.pending || !previous.pending)) {
    for (const key of surfaceKeys) delete result[key];
    Object.assign(result, pick(previous, surfaceKeys));
    delete result.pending;
  }
  // 생성 때의 위치는 보드·실행 스냅샷이 덮어쓰지 않는다.
  if (previous?.cwd !== undefined) result.cwd = previous.cwd;
  return { title: board.id, ts: { createdAt: 0, updatedAt: 0 }, ...result } as ObjectiveDocument;
}
export function boardFromDocument(doc: ObjectiveDocument, context: ObjectiveDocumentContext): StoredObjective {
  const normalized = normalizeObjectiveDocument(doc, context);
  return { ...normalized, id: doc.id, commodoreId: context.commodoreId, theaterId: context.theaterIdOf(normalized.cwd as string), cwd: normalized.cwd as string,
    rank: typeof doc.rank === "number" ? doc.rank : 0, note: typeof doc.note === "string" ? doc.note : "", missions: (doc.missions ?? []) as StoredObjective["missions"] };
}
export function documentFromObjective(node: ObjectiveRecord, previous?: ObjectiveDocument): ObjectiveDocument {
  const board = previous ? { ...previous } : { rank: -(node.ts.createdAt), note: "", missions: [], enlisted: true };
  for (const key of [...surfaceKeys, "pending"]) delete (board as Record<string, unknown>)[key];
  return { ...board, id: node.id, title: node.title, ts: node.ts, ...pick(node as unknown as Record<string, unknown>, ["groupId", "order", "accent"]), ...execution(node),
    ...(previous?.cwd !== undefined ? { cwd: previous.cwd } : {}),
    ...(node.sessions?.length ? { sessions: node.sessions.map((child) => ({ id: child.id, ts: child.ts, ...execution(child) })) } : {}),
  } as ObjectiveDocument;
}
export function objectiveRecordFromDocument(doc: ObjectiveDocument, context: ObjectiveDocumentContext): ObjectiveRecord {
  const normalized = normalizeObjectiveDocument(doc, context);
  return { ...normalized, commodoreId: context.commodoreId, theaterId: context.theaterIdOf(normalized.cwd as string) } as ObjectiveRecord;
}
const forbidden = new Set(["pluginId", "userQuestions", "resumeAvailable", "cliId", "launchKindId", "cliLabel", "launchProvider", "launchModel", "launchEffort", "providerSession", "launchKey", "geometry", "theaterId", "payload", "parentObjectiveId"]);
export function assertMinimal(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertMinimal(item); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`invalid_objective_field:${key}`);
    assertMinimal(item);
  }
}
