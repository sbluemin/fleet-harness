import type { OperationNode } from "../../execution/host/operations/operations-domain.js";
import type { StoredObjective } from "../shared/types.js";

/** 소유는 디렉터리가 나타낸다. 실행 어댑터의 옛 필드는 이 경계에서만 합성한다. */
export interface ObjectiveDocument extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly ts: { readonly createdAt: number; readonly updatedAt: number };
  readonly pending?: true;
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
  return out;
}
/** 사령관 행위자의 맥락도 파일의 소유와 같다. 기록의 나머지 내용은 그대로 둔다. */
function actors(value: unknown, theaterId?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => actors(item, theaterId));
  if (!object(value)) return value;
  const out = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "theaterId").map(([key, item]) => [key, actors(item, theaterId)]));
  if (out.kind === "commodore" && theaterId !== undefined) out.theaterId = theaterId;
  return out;
}
export function documentFromBoard(board: StoredObjective, previous?: ObjectiveDocument): ObjectiveDocument {
  const { operationId, pending, ...fields } = board;
  const retained = previous ? pick(previous, surfaceKeys) : {};
  const draft = pending ? {
    title: pending.title, groupId: pending.groupId, ts: { createdAt: pending.createdAt, updatedAt: pending.createdAt },
    session: { sessionName: pending.sessionName, ...(pending.model ? { model: pending.model } : {}), ...(pending.effort ? { effort: pending.effort } : {}) },
    chatMode: pending.viewMode === "chat", pending: true,
  } : {};
  return { id: operationId, title: operationId, ts: { createdAt: 0, updatedAt: 0 }, ...retained, ...actors(fields) as object, ...draft } as ObjectiveDocument;
}
export function boardFromDocument(doc: ObjectiveDocument, theaterId: string): StoredObjective {
  const fields: Record<string, unknown> = { ...doc };
  for (const key of ["id", "pending", ...surfaceKeys]) delete fields[key];
  const session = object(doc.session) ? doc.session : {};
  return {
    ...actors(fields, theaterId) as object, operationId: doc.id, rank: typeof doc.rank === "number" ? doc.rank : 0,
    note: typeof doc.note === "string" ? doc.note : "", missions: (doc.missions ?? []) as StoredObjective["missions"],
    ...(doc.pending ? { pending: { theaterId, title: doc.title, groupId: typeof doc.groupId === "string" ? doc.groupId : null, createdAt: doc.ts.createdAt,
      sessionName: typeof session.sessionName === "string" ? session.sessionName : doc.id,
      ...(typeof session.model === "string" ? { model: session.model } : {}), ...(typeof session.effort === "string" ? { effort: session.effort } : {}), viewMode: doc.chatMode === true ? "chat" as const : "terminal" as const } } : {}),
  };
}
export function documentFromOperation(node: OperationNode, previous?: ObjectiveDocument): ObjectiveDocument {
  const board = previous ? { ...previous } : { rank: -(node.ts.createdAt), note: "", missions: [], enlisted: true };
  for (const key of [...surfaceKeys, "pending"]) delete (board as Record<string, unknown>)[key];
  return { ...board, id: node.id, title: node.title, ts: node.ts, ...pick(node as unknown as Record<string, unknown>, ["groupId", "order", "accent"]), ...execution(node.payload),
    ...(node.childSessions?.length ? { sessions: node.childSessions.map((child) => ({ id: child.id, ts: child.ts, ...execution(child.payload) })) } : {}),
  } as ObjectiveDocument;
}
export function operationFromDocument(doc: ObjectiveDocument, theaterId: string): OperationNode {
  return { id: doc.id, theaterId, type: "agent", pluginId: null, title: doc.title, geometry: null, ts: doc.ts,
    ...pick(doc, ["groupId", "order", "accent"]), payload: execution(doc),
    ...(Array.isArray(doc.sessions) && doc.sessions.length ? { childSessions: doc.sessions.map((child) => {
      if (!object(child) || typeof child.id !== "string" || !object(child.ts)) throw new Error("invalid_objective_session");
      return { id: child.id, ts: child.ts as unknown as OperationNode["ts"], payload: execution(child) };
    }) } : {}),
  };
}
const forbidden = new Set(["pluginId", "userQuestions", "resumeAvailable", "cliId", "launchKindId", "cliLabel", "launchProvider", "launchModel", "launchEffort", "providerSession", "launchKey", "geometry", "theaterId", "payload", "parentOperationId"]);
export function assertMinimal(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertMinimal(item); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`invalid_objective_field:${key}`);
    assertMinimal(item);
  }
}
