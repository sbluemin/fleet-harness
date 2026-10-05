import { mkdir } from "node:fs/promises";
import { createClaudeGatewaySdk, type ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import { claudeGatewayModelPolicy, buildGatewayModelConstraints, difficultyQuestionId, findGatewayModel, resolveAiGatewaySelection, toClaudeGatewayModelId, type AiGatewayStoredSettings, type RoutingChoice, type RoutingDifficultyQuestion } from "@fleet-console/ai-gateway";

interface RoutingModelTurn {
  readonly baseUrl: string;
  readonly directory: string;
  readonly settings: AiGatewayStoredSettings;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Console's owned-process port: the routing model's CLI must be a child the Console's deadline ends. */
  readonly spawnProcess: ClaudeProcessSpawner;
  readonly schema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, { readonly type: "string"; readonly enum: readonly string[] }>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

/**
 * 모델 모드의 두 질문. 좌석 지시문 뒤에 난이도 지시문과 등급 기준을 붙이고, 구조화 결과의 별도 필드로
 * 받는다. Jev는 같은 두 질문을 따로 묻는다.
 */
function withDifficulty(instructions: readonly string[], difficulty: RoutingDifficultyQuestion, field: string): readonly string[] {
  return [
    ...instructions,
    `Difficulty (answer in ${field}):`,
    ...difficulty.instructions,
    ...Object.entries(difficulty.criteria).map(([level, text]) => `${level}: ${text}`),
  ];
}

/** 판단 전용 실행. 도구·플러그인·사용자 작업 디렉터리를 제공하지 않는다. */
export async function chooseRoutingModel(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly settings: AiGatewayStoredSettings;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly difficulty: RoutingDifficultyQuestion;
  readonly signal?: AbortSignal;
  /** Console's owned-process port: the routing model's CLI must be a child the Console's deadline ends. */
  readonly spawnProcess: ClaudeProcessSpawner;
}): Promise<RoutingChoice> {
  const keys = Object.keys(input.criteria);
  const parsed = await runRoutingModelTurn({
    ...input,
    instructions: withDifficulty(input.instructions, input.difficulty, "the difficulty field"),
    schema: {
      type: "object",
      properties: {
        difficulty: { type: "string", enum: Object.keys(input.difficulty.criteria) },
        choice: { type: "string", enum: keys },
      },
      required: ["difficulty", "choice"],
      additionalProperties: false,
    },
  });
  if (!parsed || typeof parsed !== "object" || !("choice" in parsed) || typeof parsed.choice !== "string"
    || !Object.hasOwn(input.criteria, parsed.choice)) throw new Error("Invalid routing model choice");
  const difficulty = (parsed as { difficulty?: unknown }).difficulty;
  return { seat: parsed.choice, ...(typeof difficulty === "string" ? { difficulty } : {}) };
}

/**
 * 배치 판단. 스키마의 필수 속성은 태스크 id `t0`…`tN-1`(후보 키 enum)과 그 난이도 필드다.
 * 좌석이 빠지거나 후보가 아닌 값은 결과에서 빼 호출자가 그 항목만 fallback하게 한다.
 * 구조화 결과 자체가 없으면 한 건 경로와 같이 던진다.
 */
export async function chooseRoutingModels(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly settings: AiGatewayStoredSettings;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly difficulty: RoutingDifficultyQuestion;
  readonly tasks: readonly string[];
  readonly signal?: AbortSignal;
  /** Console's owned-process port: the routing model's CLI must be a child the Console's deadline ends. */
  readonly spawnProcess: ClaudeProcessSpawner;
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

async function runRoutingModelTurn(input: RoutingModelTurn): Promise<unknown> {
  const selected = input.settings.delegationRoutingModel ?? "sonnet";
  const model = findGatewayModel(selected);
  const isClaude = model?.provider === "claude" || ["sonnet", "opus"].includes(selected);
  const selection = resolveAiGatewaySelection(input.settings);
  if (!["sonnet", "opus"].includes(selected) && (!model || !selection.models.some(entry => entry.id === model.id))) {
    throw new Error("Routing model is not exposed");
  }
  const id = isClaude ? (model ? toClaudeGatewayModelId(model) : selected) : (model ? `claude-gateway--${model.id}` : selected);
  const constraints = model ? buildGatewayModelConstraints(model) : undefined;
  const ladder = model && constraints ? selection.effortExposure[model.id] ?? constraints.effortLadder : [];
  const effort = constraints ? (constraints.effortSupported
    ? (ladder.includes("low") ? "low" : ladder[0]) : undefined) : "low";
  await mkdir(input.directory, { recursive: true });
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Routing model timed out")), 30_000);
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
    return parsed;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await sdk?.dispose();
  }
}
