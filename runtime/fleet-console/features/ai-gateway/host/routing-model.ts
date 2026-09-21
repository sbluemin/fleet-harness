import { mkdir } from "node:fs/promises";
import { createClaudeGatewaySdk } from "@fleet-console/agent-runtime/claude";
import { claudeGatewayModelPolicy, buildGatewayModelConstraints, findGatewayModel, resolveAiGatewaySelection, toClaudeGatewayModelId, type AiGatewayStoredSettings } from "@fleet-console/ai-gateway";

/** 판단 전용 실행. 도구·플러그인·사용자 작업 디렉터리를 제공하지 않는다. */
export async function chooseRoutingModel(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly settings: AiGatewayStoredSettings;
  readonly instructions: readonly string[];
  readonly state: unknown;
  readonly criteria: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<string> {
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
      plugins: [],
      allowAmbientMcpServers: false,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    const run = await sdk.startTurn({
      model: id, ...(effort ? { effort } : {}), cwd: input.directory,
      prompt: JSON.stringify({
        instructions: [...input.instructions,
          'Return only a JSON object with one property: "choice", containing an offered candidate key. No markdown or explanation.',
        ],
        state: input.state,
        candidates: input.criteria,
      }),
      tools: [], persistSession: false, maxTurns: 1, permissionMode: "dontAsk", abortController: controller,
    });
    let result: string | undefined;
    for await (const message of run) {
      if (message.type === "result" && message.subtype === "success" && typeof message.result === "string") result = message.result;
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!result) throw new Error("Routing model returned no result");
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object" || !("choice" in parsed) || typeof parsed.choice !== "string"
      || !Object.hasOwn(input.criteria, parsed.choice)) throw new Error("Invalid routing model choice");
    return parsed.choice;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await sdk?.dispose();
  }
}
