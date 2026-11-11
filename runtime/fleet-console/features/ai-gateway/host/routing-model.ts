import { mkdir } from "node:fs/promises";
import { createClaudeGatewaySdk, type ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import { claudeGatewayModelPolicy, difficultyQuestionId, type ProviderStatusMap, type RoutingChoice, type RoutingDifficultyQuestion } from "@fleet-console/ai-gateway";
import { clampRosterEffort, findRosterRow, isAgentEffort, rosterRowEfforts } from "../shared/models.js";
import { buildModelRoster, rosterWireModelId } from "./model-roster.js";

interface RoutingModelTurn {
  readonly baseUrl: string;
  readonly directory: string;
  readonly judge: { readonly model: string; readonly effort?: string };
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Console's owned-process port: the routing model's CLI must be a child the Console's deadline ends. */
  readonly spawnProcess: ClaudeProcessSpawner;
  /** 공급자 로그인. 없으면 미상으로 보고 카탈로그 전체를 쓴다. */
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
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
  readonly baseUrl: string;
  readonly directory: string;
  readonly judge: { readonly model: string; readonly effort?: string };
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly difficulty: RoutingDifficultyQuestion;
  readonly tasks: readonly string[];
  readonly signal?: AbortSignal;
  /** Console's owned-process port: the routing model's CLI must be a child the Console's deadline ends. */
  readonly spawnProcess: ClaudeProcessSpawner;
  /** 공급자 로그인. 없으면 미상으로 보고 카탈로그 전체를 쓴다. */
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
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
  try {
    return read();
  } catch {
    return undefined;
  }
}

async function runRoutingModelTurn(input: RoutingModelTurn): Promise<unknown> {
  const roster = buildModelRoster("agent", routingProviderStatuses(input.readProviderStatuses));
  const row = findRosterRow(roster, input.judge.model);
  if (!row) throw new Error("Routing judge model is unavailable");
  const id = rosterWireModelId(row.launch.model ?? row.id);
  // 판단은 윗선 세션의 모델·강도로 돈다. 윗선이 강도를 정하지 않았으면 여기서도 정하지 않고 그 모델의 기본을 쓴다.
  const rung = input.judge.effort === undefined ? undefined : clampRosterEffort(rosterRowEfforts(row), input.judge.effort);
  const effort = isAgentEffort(rung) ? rung : undefined;
  await mkdir(input.directory, { recursive: true });
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Routing model timed out")), 30_000);
  process.stderr.write(`[fleet-routing-model] ${JSON.stringify({ ts: new Date().toISOString(), event: "judge_request", model: input.judge.model, effort: effort ?? null, tasks: input.schema.required.length / 2 })}\n`);
  let sdk: Awaited<ReturnType<typeof createClaudeGatewaySdk>> | undefined;
  try {
    sdk = await createClaudeGatewaySdk({
      modelPolicy: claudeGatewayModelPolicy,
      baseUrl: input.baseUrl,
      models: [id],
      tempRoot: input.directory,
      home: { kind: "isolated" },
      settingSources: [],
      allowAmbientMcpServers: false,
      spawnProcess: input.spawnProcess,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    const run = await sdk.startTurn({
      model: id, ...(effort ? { effort } : {}), cwd: input.directory,
      systemPrompt: { mode: "replace", text: input.instructions.join("\n\n") },
      prompt: JSON.stringify({ state: input.state, candidates: input.criteria }),
      outputFormat: { type: "json_schema", schema: input.schema },
      tools: [], persistSession: false, maxTurns: 1, permissionMode: "dontAsk", abortController: controller,
    });
    let parsed: unknown;
    for await (const message of run) {
      if (message.type === "result" && message.subtype === "success") parsed = message.structured_output;
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    if (parsed === undefined) throw new Error("Routing model returned no structured result");
    const record = parsed as Record<string, unknown>;
    if (!record || typeof record !== "object") throw new Error("Invalid routing model choice");
    const valid = input.schema.required.every(key => typeof record[key] === "string"
      && input.schema.properties[key]?.enum.includes(record[key] as string));
    process.stderr.write(`[fleet-routing-model] ${JSON.stringify({ ts: new Date().toISOString(), event: "judge_result", ok: valid, reason: valid ? null : "partial or invalid routing model choice" })}\n`);
    return parsed;
  } catch (error) {
    process.stderr.write(`[fleet-routing-model] ${JSON.stringify({ ts: new Date().toISOString(), event: "judge_result", ok: false, reason: error instanceof Error ? error.message : String(error) })}\n`);
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await sdk?.dispose();
  }
}
