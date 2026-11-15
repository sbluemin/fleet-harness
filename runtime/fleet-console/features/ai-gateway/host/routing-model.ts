import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeGatewaySdk, type ClaudeGatewaySdk, type ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import { claudeGatewayModelPolicy, difficultyQuestionId, type ProviderStatusMap, type RoutingChoice, type RoutingDifficultyQuestion } from "@fleet-console/ai-gateway";
import { clampRosterEffort, findRosterRow, isAgentEffort, rosterRowEfforts } from "../shared/models.js";
import { buildModelRoster, rosterWireModelId } from "./model-roster.js";

/** 목표 id. 세션 맵의 키이며 경로로 쓰지 않는다. */
const OBJECTIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function routingObjectiveId(value: unknown): string | undefined {
  return typeof value === "string" && OBJECTIVE_ID.test(value) ? value : undefined;
}

export interface RoutingAssignment {
  readonly model: string;
  readonly effort?: string;
}

export interface RoutingAssignRequest {
  readonly objectiveId: string;
  readonly judge: RoutingAssignment;
  readonly commander?: RoutingAssignment;
  readonly items: { key: string; prompt: string }[];
}

/**
 * `routing-assign` 본문. 목표 id가 없으면 세션을 만들 자리가 없으므로 거절한다.
 * 지휘관 배정은 선택이다 — 있으면 확정된 모델·강도만 남긴다.
 */
export function parseRoutingAssignRequest(body: unknown): RoutingAssignRequest | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { objectiveId?: unknown; judge?: unknown; commander?: unknown; items?: unknown };
  const objectiveId = routingObjectiveId(record.objectiveId);
  if (!objectiveId) return undefined;
  const judge = readAssignment(record.judge);
  if (!judge) return undefined;
  const commander = record.commander === undefined ? undefined : readAssignment(record.commander);
  if (record.commander !== undefined && !commander) return undefined;
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 20) return undefined;
  const seen = new Set<string>();
  let total = 0;
  const items: { key: string; prompt: string }[] = [];
  for (const item of record.items) {
    if (!item || typeof item !== "object") return undefined;
    const { key, prompt } = item as { key?: unknown; prompt?: unknown };
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(key) || seen.has(key)
      || typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_384) return undefined;
    total += prompt.length;
    if (total > 131_072) return undefined;
    seen.add(key);
    items.push({ key, prompt });
  }
  return { objectiveId, judge, ...(commander ? { commander } : {}), items };
}

function readAssignment(value: unknown): RoutingAssignment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { model, effort } = value as { model?: unknown; effort?: unknown };
  if (typeof model !== "string" || !model.trim() || model.length > 512) return undefined;
  if (effort !== undefined && (typeof effort !== "string" || effort.length > 32)) return undefined;
  return { model, ...(typeof effort === "string" && effort ? { effort } : {}) };
}

type DisposeReason = "model_change" | "failure" | "archive" | "shutdown";

interface LiveSession {
  readonly wireModel: string;
  readonly sessionId: string;
  readonly scratch: string;
  /** 이어서 성공한 턴 수. 이번 턴 번호는 여기에 1을 더한 값이다. */
  turn: number;
  abort: AbortController | null;
  sdk?: ClaudeGatewaySdk;
}

interface Slot {
  tail: Promise<void>;
  session: LiveSession | null;
  /** 보관은 이 프로세스에서 그 키를 다시 열지 않는다. 종료는 슬롯을 지운다. */
  closed: "archive" | null;
  release: DisposeReason | null;
}

const slots = new Map<string, Slot>();

function slotOf(objectiveId: string): Slot {
  let slot = slots.get(objectiveId);
  if (!slot) {
    slot = { tail: Promise.resolve(), session: null, closed: null, release: null };
    slots.set(objectiveId, slot);
  }
  return slot;
}

function enqueue<T>(objectiveId: string, run: (slot: Slot) => Promise<T>): Promise<T> {
  const slot = slotOf(objectiveId);
  const task = slot.tail.then(() => run(slot));
  slot.tail = task.then(() => undefined, () => undefined);
  return task;
}

function logJudge(fields: {
  readonly event: "judge_request" | "judge_result";
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly tasks?: number | null;
  readonly session: "created" | "resumed" | null;
  readonly turn: number | null;
  readonly disposeReason: DisposeReason | null;
  readonly ok?: boolean;
  readonly reason?: string | null;
}): void {
  process.stderr.write(`[fleet-routing-model] ${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}

function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split("\n")[0] ?? "routing judgment failed";
  return line.length > 180 ? line.slice(0, 180) : line;
}

/** 프로세스와 임시 홈을 걷는다. 세션이 없으면 로그를 남기지 않는다. 턴이 이미 같은 폐기를 적었으면 다시 적지 않는다. */
async function destroy(slot: Slot, reason: DisposeReason, silent = false): Promise<void> {
  const session = slot.session;
  slot.session = null;
  if (!session) return;
  session.abort?.abort();
  await session.sdk?.dispose().catch(() => undefined);
  session.sdk = undefined;
  await rm(session.scratch, { recursive: true, force: true });
  if (silent) return;
  logJudge({
    event: "judge_result", ok: false, reason: null, model: session.wireModel, effort: null, tasks: null,
    session: "resumed", turn: session.turn > 0 ? session.turn : null, disposeReason: reason,
  });
}

/** 목표 보관. 진행 중인 턴이 있으면 그 턴이 끝난 뒤 임시 홈을 지우고, 같은 키는 다시 열지 않는다. */
export function releaseRoutingSession(objectiveId: string): Promise<void> {
  if (!OBJECTIVE_ID.test(objectiveId)) return Promise.resolve();
  const slot = slotOf(objectiveId);
  slot.closed = "archive";
  slot.release = "archive";
  slot.session?.abort?.abort();
  return enqueue(objectiveId, async (current) => { await destroy(current, "archive"); });
}

/** Console 종료. 진행 중인 턴을 끊고 남은 임시 홈을 모두 지운다. */
export async function releaseAllRoutingSessions(): Promise<void> {
  const ids = [...slots.keys()];
  for (const id of ids) {
    const slot = slots.get(id);
    if (!slot) continue;
    slot.release = "shutdown";
    slot.session?.abort?.abort();
  }
  await Promise.all(ids.map(async (id) => {
    const slot = slots.get(id);
    if (!slot) return;
    await enqueue(id, async (current) => {
      await destroy(current, "shutdown");
      if (slots.get(id) === current) slots.delete(id);
    });
  }));
}

interface RoutingModelTurn {
  readonly objectiveId: string;
  readonly baseUrl: string;
  readonly judge: RoutingAssignment;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly spawnProcess: ClaudeProcessSpawner;
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  readonly resolveExecutable?: () => Promise<string | undefined>;
  readonly createSdk?: typeof createClaudeGatewaySdk;
  readonly schema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, { readonly type: "string"; readonly enum: readonly string[] }>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

function withDifficulty(instructions: readonly string[], difficulty: RoutingDifficultyQuestion, field: string): readonly string[] {
  return [...instructions, `Difficulty (answer in ${field}):`, ...difficulty.instructions,
    ...Object.entries(difficulty.criteria).map(([level, text]) => `${level}: ${text}`)];
}

/**
 * 배치 판단. 스키마의 필수 속성은 태스크 id `t0`…`tN-1`(후보 키 enum)과 그 난이도 필드다.
 * 좌석이 빠지거나 후보가 아닌 값은 결과에서 빼 호출자가 그 항목만 fallback하게 한다.
 * 구조화 결과 자체가 없으면 한 건 경로와 같이 던진다.
 */
export async function chooseRoutingModels(input: {
  readonly objectiveId: string;
  readonly baseUrl: string;
  readonly judge: RoutingAssignment;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly difficulty: RoutingDifficultyQuestion;
  readonly tasks: readonly string[];
  readonly signal?: AbortSignal;
  readonly spawnProcess: ClaudeProcessSpawner;
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  readonly resolveExecutable?: () => Promise<string | undefined>;
  readonly createSdk?: typeof createClaudeGatewaySdk;
}): Promise<Record<string, RoutingChoice>> {
  const keys = Object.keys(input.criteria);
  const levels = Object.keys(input.difficulty.criteria);
  const fields = input.tasks.flatMap(id => [id, difficultyQuestionId(id)]);
  const parsed = await runRoutingModelTurn({
    ...input,
    instructions: withDifficulty(input.instructions, input.difficulty, "each task's <id>_difficulty field"),
    schema: {
      type: "object",
      properties: Object.fromEntries(input.tasks.flatMap(id => [
        [id, { type: "string" as const, enum: keys }],
        [difficultyQuestionId(id), { type: "string" as const, enum: levels }],
      ])),
      required: fields,
      additionalProperties: false,
    },
  });
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid routing model choice");
  const record = parsed as Record<string, unknown>;
  const choices: Record<string, RoutingChoice> = {};
  for (const id of input.tasks) {
    const value = record[id];
    const difficulty = record[difficultyQuestionId(id)];
    if (typeof value === "string" && Object.hasOwn(input.criteria, value)) {
      choices[id] = { seat: value, ...(typeof difficulty === "string" ? { difficulty } : {}) };
    }
  }
  return choices;
}

function routingProviderStatuses(read: (() => ProviderStatusMap | undefined) | undefined): ProviderStatusMap | undefined {
  if (!read) return undefined;
  try { return read(); } catch { return undefined; }
}

async function runRoutingModelTurn(input: RoutingModelTurn): Promise<unknown> {
  if (!OBJECTIVE_ID.test(input.objectiveId)) throw new Error("Routing objective is invalid");
  return enqueue(input.objectiveId, (slot) => runQueuedTurn(slot, input));
}

async function runQueuedTurn(slot: Slot, input: RoutingModelTurn): Promise<unknown> {
  if (slot.closed) throw new Error("Routing session disposed");
  const roster = buildModelRoster("agent", routingProviderStatuses(input.readProviderStatuses));
  const row = findRosterRow(roster, input.judge.model);
  if (!row) {
    const existing = slot.session;
    logJudge({
      event: "judge_result", ok: false, reason: "Routing judge model is unavailable", model: input.judge.model, effort: null,
      tasks: input.schema.required.length / 2, session: existing ? "resumed" : null, turn: existing ? existing.turn + 1 : null,
      disposeReason: existing ? "failure" : null,
    });
    if (existing) await destroy(slot, "failure", true);
    throw new Error("Routing judge model is unavailable");
  }
  const wireModel = rosterWireModelId(row.launch.model ?? row.id);
  const rung = input.judge.effort === undefined ? undefined : clampRosterEffort(rosterRowEfforts(row), input.judge.effort);
  const effort = isAgentEffort(rung) ? rung : undefined;
  if (slot.session && slot.session.wireModel !== wireModel) await destroy(slot, "model_change");
  if (slot.closed) throw new Error("Routing session disposed");
  let created = false;
  if (!slot.session) {
    const scratch = await mkdtemp(path.join(tmpdir(), "fleet-routing-"));
    const configDir = path.join(scratch, "claude");
    await mkdir(configDir, { recursive: true });
    if (slot.closed || slot.release) {
      await rm(scratch, { recursive: true, force: true });
      throw new Error("Routing session disposed");
    }
    slot.session = { wireModel, sessionId: randomUUID(), scratch, turn: 0, abort: null };
    created = true;
  }
  const session = slot.session;
  const turn = session.turn + 1;
  const resumed = !created;
  logJudge({
    event: "judge_request", model: input.judge.model, effort: effort ?? null, tasks: input.schema.required.length / 2,
    session: created ? "created" : "resumed", turn, disposeReason: null,
  });
  const controller = new AbortController();
  session.abort = controller;
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Routing model timed out")), 30_000);
  let failed: unknown;
  try {
    const executablePath = await input.resolveExecutable?.();
    const sdk = await (input.createSdk ?? createClaudeGatewaySdk)({
      modelPolicy: claudeGatewayModelPolicy,
      baseUrl: input.baseUrl,
      models: [wireModel],
      home: { kind: "persistent", configDir: path.join(session.scratch, "claude") },
      settingSources: [],
      allowAmbientMcpServers: false,
      spawnProcess: input.spawnProcess,
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    session.sdk = sdk;
    if (controller.signal.aborted || slot.closed || slot.release) throw controller.signal.reason ?? new Error("Routing session disposed");
    const run = await sdk.startTurn({
      model: wireModel, ...(effort ? { effort } : {}), cwd: session.scratch,
      systemPrompt: { mode: "replace", text: input.instructions.join("\n\n") },
      prompt: JSON.stringify({ state: input.state, candidates: input.criteria }),
      outputFormat: { type: "json_schema", schema: input.schema },
      tools: [], persistSession: true, maxTurns: 1, permissionMode: "dontAsk", abortController: controller,
      ...(resumed ? { resume: session.sessionId } : { sessionId: session.sessionId }),
    });
    let parsed: unknown;
    for await (const message of run) {
      if (message.type === "result" && message.subtype === "success") parsed = message.structured_output;
    }
    if (controller.signal.aborted || slot.closed || slot.release) throw controller.signal.reason ?? new Error("Routing session disposed");
    if (parsed === undefined) throw new Error("Routing model returned no structured result");
    const record = parsed as Record<string, unknown>;
    if (!record || typeof record !== "object") throw new Error("Invalid routing model choice");
    const valid = input.schema.required.every(key => typeof record[key] === "string"
      && input.schema.properties[key]?.enum.includes(record[key] as string));
    logJudge({
      event: "judge_result", ok: valid, reason: valid ? null : "partial or invalid routing model choice",
      model: input.judge.model, effort: effort ?? null, tasks: input.schema.required.length / 2,
      session: created ? "created" : "resumed", turn, disposeReason: null,
    });
    if (!slot.closed && !slot.release && slot.session === session) session.turn = turn;
    return parsed;
  } catch (error) {
    failed = error;
    logJudge({
      event: "judge_result", ok: false, reason: failureReason(error),
      model: input.judge.model, effort: effort ?? null, tasks: input.schema.required.length / 2,
      session: created ? "created" : "resumed", turn, disposeReason: slot.closed ?? slot.release ?? "failure",
    });
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await session.sdk?.dispose().catch(() => undefined);
    if (session.sdk) session.sdk = undefined;
    session.abort = null;
    if (slot.session === session && (failed !== undefined || slot.closed || slot.release)) {
      await destroy(slot, slot.closed ?? slot.release ?? "failure", failed !== undefined);
    }
  }
}
