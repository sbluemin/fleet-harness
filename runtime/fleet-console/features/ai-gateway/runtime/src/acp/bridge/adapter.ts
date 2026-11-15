import { randomUUID } from "node:crypto";
import os from "node:os";

import {
  canonicalMessageImages,
  canonicalMessageText,
  type AdapterCallOptions,
  type AdapterResponse,
  type AiGatewayAdapter,
  type CanonicalFunctionCallOutput,
  type CanonicalInputItem,
  type CanonicalResponseEvent,
  type CanonicalResponseRequest,
} from "../../canonical/index.js";
import { estimateTokens } from "../../transport/token-estimate.js";
import { wireLog } from "../../transport/wire-log.js";
import { AcpAuthRequiredError, AcpModelUnavailableError, type AcpPromptBlock, type AcpSessionPort } from "../contract.js";
import { parseAgyUpstreamError, type AgyUpstreamError } from "../events.js";
import { resolveAcpModelSelection, type AcpModelSelection } from "../models.js";
import { AGY_INERT_TOOL_TITLES, toolOnlyTitlePrefix } from "../tool-only.js";
import {
  chainAfterAssistant,
  chainOf,
  REPLAY_SYSTEM_NOTE,
  replayBlocks,
  userTurnBlocks,
} from "./history.js";
import { stripClaudeCodeIdentity } from "./claude-code-system.js";
import { BridgeMcpServer, type BridgeToolDef, type McpResultContent, type McpToolOutcome } from "./mcp-server.js";
import {
  BridgeSession,
  READ_ABORTED,
  READ_TIMEOUT,
  SessionRegistry,
  type BridgedCall,
} from "./registry.js";

/**
 * Anthropic Messages ↔ `agy acp` 브리지 어댑터.
 *
 * Claude Code가 보낸 Messages 요청(이미 canonical로 번역됨)을, 살아 있는 agy 세션 위의 한 턴으로 바꾼다.
 * 도구는 루프백 MCP 서버로 agy에 보여 주고(`mcp-server.ts`), 모델이 도구를 부르면 응답을 `tool_use`로 끝낸 채
 * MCP 호출을 붙잡아 둔다. 다음 요청의 tool_result가 그 호출을 풀어 같은 agy prompt를 이어 간다.
 *
 * 요청 처리는 세 갈래다. 이력 체인(`history.ts`)이 어느 세션의 기대와 맞는지로 가른다.
 * - 새 턴: 세션이 `idle`이고 꼬리가 사용자 메시지 → 같은 세션에 새 `session/prompt`.
 * - 이어가기: 세션이 `awaiting_tools`이고 꼬리가 방출한 모든 tool_use의 결과 → 보류 MCP 호출을 푼다.
 * - 새 세션: 짝이 없거나 어긋남(압축·되감기·재시도·agy의 호출 포기·도구 집합 변경) → 세션을 새로 열고 이력을 재주입한다.
 *
 * resume은 없다. Fleet이 다시 뜨면 레지스트리는 비어 있고 모든 요청이 새 세션으로 시작한다.
 */

export interface AgyAcpBridgeOptions {
  readonly port: AcpSessionPort;
  /** 테스트가 주입한다. 없으면 루프백 서버를 지연 시작한다. */
  readonly mcp?: BridgeMcpServer;
  readonly maxSessions?: number;
  /** 도구 결과를 기다리는 최대 시간(ms). `callTimeoutSeconds`보다 짧아야 한다. */
  readonly holdMs?: number;
  readonly idleTtlMs?: number;
  /** 응답 중 agy가 아무것도 보내지 않는 한도(ms). */
  readonly silenceMs?: number;
  /** 첫 도구 호출 뒤 같은 응답에 더 모아 싣기 위해 기다리는 시간(ms). agy는 도구를 직렬로 실행한다(실측). */
  readonly coalesceMs?: number;
  readonly replayBudgetChars?: number;
  /** agy가 MCP 호출 하나를 붙잡는 한도(초). 기본 agy는 180초라 길게 늘린다. */
  readonly callTimeoutSeconds?: number;
}

export interface AgyAcpBridge extends AiGatewayAdapter {
  /** 열려 있는 세션과 MCP 리스너를 닫는다. */
  dispose(): Promise<void>;
}

const MCP_SERVER_NAME = "fleet";
/** 응답을 내보내기 전에 첫 출력을 기다리는 최대 시간. 첫 출력이 업스트림 오류 알림이면 HTTP 오류로 끝낸다. */
const FIRST_OUTPUT_WAIT_MS = 8_000;
const DEFAULTS = {
  maxSessions: 8,
  callTimeoutSeconds: 3_600,
  idleTtlMs: 20 * 60_000,
  silenceMs: 300_000,
  coalesceMs: 40,
  replayBudgetChars: 1_500_000,
} as const;
const MCP_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,47}$/;

function bridgeNote(): string {
  return "Call tools by their listed `mcp_fleet_` names (`Bash` → `mcp_fleet_Bash`). Do not work around unavailable tools.";
}

/** MCP로 노출할 이름: agy·Gemini가 받는 형식이면 그대로, 아니면 되돌릴 수 있는 별칭. */
function exposedName(name: string, taken: ReadonlyMap<string, string>): string {
  const base = MCP_TOOL_NAME.test(name)
    ? name
    : `${name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]/, "_").slice(0, 38)}_${randomUUID().slice(0, 8)}`;
  return taken.has(base) && taken.get(base) !== name ? `${base.slice(0, 38)}_${randomUUID().slice(0, 8)}` : base;
}

function toolCatalog(request: CanonicalResponseRequest): { tools: BridgeToolDef[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  const tools: BridgeToolDef[] = [];
  for (const tool of request.tools ?? []) {
    const exposed = exposedName(tool.name, names);
    names.set(exposed, tool.name);
    // 이름이 바뀐 도구에만, 원래 이름을 설명 끝에 코드로 덧붙인다(전체 매핑표는 프롬프트에 넣지 않는다).
    const description = tool.description ?? "";
    tools.push({
      name: exposed,
      description: exposed === tool.name ? description : `${description}${description.length > 0 ? " " : ""}Original tool name: ${tool.name}.`,
      inputSchema: tool.parameters,
    });
  }
  return { tools, names };
}

/**
 * Counts only (never content or length) of what rides next to the tool results at the end of a request: how often user text
 * accompanies them is what decides how the `[user note]` path should work. The tail is the user-side run after the last
 * assistant item, the same run `outcomesFor` reads. Text parts of one message are already one canonical item, so a
 * count is per message item, not per Anthropic content block; both user and system-role messages count, as in `outcomesFor`.
 */
function tailCounts(items: readonly CanonicalInputItem[]): { tailToolResults: number; tailUserTexts: number; tailReminderTexts: number } {
  let start = items.length;
  while (start > 0 && isUserSide(items[start - 1]!)) start -= 1;
  const tail = items.slice(start);
  const tailToolResults = tail.filter((item) => item.type === "function_call_output").length;
  const texts = tailToolResults === 0
    ? []
    : tail.flatMap((item) => (item.type === "message" ? [canonicalMessageText(item.content)] : [])).filter((text) => text.length > 0);
  return {
    tailToolResults,
    tailUserTexts: texts.length,
    tailReminderTexts: texts.filter((text) => text.trimStart().startsWith("<system-reminder>")).length,
  };
}

function failedResponse(status: number, type: string, message: string): AdapterResponse {
  return {
    ok: false,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify({ type: "error", error: { type, message } })),
  };
}

function resultContent(output: CanonicalFunctionCallOutput["output"]): McpResultContent[] {
  const text = canonicalMessageText(output);
  const content: McpResultContent[] = text.length > 0 ? [{ type: "text", text }] : [];
  for (const image of canonicalMessageImages(output)) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.image_url);
    content.push(match ? { type: "image", mimeType: match[1]!, data: match[2]! } : { type: "text", text: `[image: ${image.image_url}]` });
  }
  return content.length > 0 ? content : [{ type: "text", text: "(no output)" }];
}

/** agy가 알린 업스트림 오류를 Anthropic 오류 형식(HTTP 상태와 오류 type)으로 옮긴다. */
function upstreamFailure(error: AgyUpstreamError): { readonly status: number; readonly type: string; readonly message: string } {
  const message = `agy upstream error${error.status ? ` ${error.status}` : ""}${error.code ? ` (code ${error.code})` : ""}: ${error.message}`;
  const code = error.code;
  const status = error.status;
  if (code === 429 || status === "RESOURCE_EXHAUSTED") return { status: 429, type: "rate_limit_error", message };
  if (code === 401 || status === "UNAUTHENTICATED") return { status: 401, type: "authentication_error", message };
  if (code === 403 || status === "PERMISSION_DENIED") return { status: 403, type: "permission_error", message };
  if (code === 404 || status === "NOT_FOUND") return { status: 404, type: "not_found_error", message };
  if (code === 400 || status === "INVALID_ARGUMENT" || status === "FAILED_PRECONDITION") return { status: 400, type: "invalid_request_error", message };
  if (code === 503 || code === 529 || status === "UNAVAILABLE") return { status: 529, type: "overloaded_error", message };
  if (code === 504 || status === "DEADLINE_EXCEEDED") return { status: 504, type: "api_error", message };
  return { status: code !== undefined && code >= 500 && code <= 599 ? code : 500, type: "api_error", message };
}

type Plan =
  | { readonly route: "new-turn"; readonly session: BridgeSession; readonly tail: readonly CanonicalInputItem[] }
  | { readonly route: "continue"; readonly session: BridgeSession; readonly outcomes: ReadonlyMap<string, McpToolOutcome> }
  | { readonly route: "fresh" }
  | { readonly route: "rebuild"; readonly reason: string };

function isUserSide(item: CanonicalInputItem): boolean {
  return item.type === "function_call_output" || (item.type === "message" && item.role !== "assistant");
}

class AgyAcpBridgeAdapter implements AgyAcpBridge {
  readonly capabilities = {} as const;
  private readonly registry: SessionRegistry;
  private readonly mcp: BridgeMcpServer;
  private readonly limits: Required<Pick<AgyAcpBridgeOptions, "silenceMs" | "coalesceMs" | "replayBudgetChars" | "callTimeoutSeconds">> & { holdMs: number; idleTtlMs: number };

  constructor(private readonly options: AgyAcpBridgeOptions) {
    this.mcp = options.mcp ?? new BridgeMcpServer();
    this.registry = new SessionRegistry(options.maxSessions ?? DEFAULTS.maxSessions);
    const callTimeoutSeconds = options.callTimeoutSeconds ?? DEFAULTS.callTimeoutSeconds;
    this.limits = {
      callTimeoutSeconds,
      // 호출 한도보다 짧게: 우리가 먼저 포기해야 agy의 타임아웃 출력이 새어 나가지 않는다.
      holdMs: options.holdMs ?? Math.max(1_000, callTimeoutSeconds * 1_000 - 60_000),
      idleTtlMs: options.idleTtlMs ?? DEFAULTS.idleTtlMs,
      silenceMs: options.silenceMs ?? DEFAULTS.silenceMs,
      coalesceMs: options.coalesceMs ?? DEFAULTS.coalesceMs,
      replayBudgetChars: options.replayBudgetChars ?? DEFAULTS.replayBudgetChars,
    };
  }

  async dispose(): Promise<void> {
    await this.registry.closeAll("bridge disposed");
    await this.mcp.close();
  }

  async stream(request: CanonicalResponseRequest, options: AdapterCallOptions): Promise<AdapterResponse> {
    let selection: AcpModelSelection;
    try {
      selection = resolveAcpModelSelection(request.model, request.reasoning?.effort as Parameters<typeof resolveAcpModelSelection>[1]);
    } catch (error) {
      return failedResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
    }
    const last = request.input[request.input.length - 1];
    if (!last || !isUserSide(last)) {
      return failedResponse(400, "invalid_request_error", "The request must end with a user message or tool results.");
    }

    const catalog = toolCatalog(request);
    const seed = `${selection.baseId}|${selection.thoughtLevel}|${[...catalog.names.keys()].sort().join(",")}`;
    const chain = chainOf(seed, request.input);
    const plan = this.classify(chain, request.input);
    wireLog("bridge.request", {
      route: plan.route,
      ...("reason" in plan ? { reason: plan.reason } : {}),
      ...("session" in plan ? { session: plan.session.key } : {}),
      items: request.input.length,
      tools: catalog.tools.length,
      ...tailCounts(request.input),
    });

    let session: BridgeSession;
    try {
      if (plan.route === "continue") {
        session = plan.session;
        this.registry.unexpect(session);
        session.resolveCalls(plan.outcomes);
      } else if (plan.route === "new-turn") {
        session = plan.session;
        this.registry.unexpect(session);
        await session.startPrompt(userTurnBlocks(plan.tail));
      } else {
        const blocks = plan.route === "fresh"
          ? userTurnBlocks(request.input)
          : replayBlocks(request.input, this.limits.replayBudgetChars);
        session = await this.openSession(request, selection, seed, catalog, plan.route === "rebuild", options.signal);
        await session.startPrompt(blocks);
      }
    } catch (error) {
      return this.openFailure(error);
    }

    // agy는 업스트림 오류(429 등)를 재시도하며 그 알림을 모델 출력처럼 흘린다. 응답을 시작하기 전에 첫 출력을
    // 보고, 오류 알림이면 재시도를 기다리지 않고 Messages 오류(HTTP 상태)로 끝낸다. 오래 걸리면 그대로 스트림을 연다.
    const first = await session.channel.scan(
      (item) => item.kind !== "acp" || ["text", "thought", "turn-end", "exit"].includes(item.event.kind),
      FIRST_OUTPUT_WAIT_MS,
      options.signal,
    );
    if (typeof first === "object" && first.kind === "acp" && first.event.kind === "text") {
      const upstream = parseAgyUpstreamError(first.event.text);
      if (upstream) {
        const failure = upstreamFailure(upstream);
        wireLog("bridge.upstream_error", { session: session.key, status: failure.status, type: failure.type });
        await session.close(failure.message);
        return failedResponse(failure.status, failure.type, failure.message);
      }
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      events: this.respond(session, { model: request.model, baseChain: chain[chain.length - 1]!, signal: options.signal }),
    };
  }

  private classify(chain: readonly string[], items: readonly CanonicalInputItem[]): Plan {
    for (let prefix = items.length - 1; prefix >= 1; prefix -= 1) {
      const session = this.registry.lookup(chain[prefix]!);
      if (!session) continue;
      const tail = items.slice(prefix);
      if (!tail.every(isUserSide)) return { route: "rebuild", reason: "assistant items after the matched prefix" };
      const outputs = tail.filter((item): item is CanonicalFunctionCallOutput => item.type === "function_call_output");
      if (session.state === "idle") {
        return outputs.length === 0 ? { route: "new-turn", session, tail } : { route: "rebuild", reason: "tool results for an idle session" };
      }
      if (session.state === "awaiting_tools") {
        const outcomes = this.outcomesFor(session, tail, outputs);
        return outcomes ? { route: "continue", session, outcomes } : { route: "rebuild", reason: "tool results do not match the pending tool calls" };
      }
      return { route: "rebuild", reason: `matched session is ${session.state}` };
    }
    return items.every(isUserSide) && !items.some((item) => item.type === "function_call_output")
      ? { route: "fresh" }
      : { route: "rebuild", reason: "no session matches this history" };
  }

  private outcomesFor(
    session: BridgeSession,
    tail: readonly CanonicalInputItem[],
    outputs: readonly CanonicalFunctionCallOutput[],
  ): ReadonlyMap<string, McpToolOutcome> | undefined {
    const emitted = [...session.pending.values()].filter((call) => call.emitted).map((call) => call.callId);
    const ids = new Set(outputs.map((output) => output.call_id));
    if (emitted.length === 0 || ids.size !== outputs.length || ids.size !== emitted.length || !emitted.every((id) => ids.has(id))) return undefined;
    // 도구 결과 뒤에 붙은 사용자 텍스트(system-reminder 등)는 MCP 응답 말고는 agy로 돌려보낼 통로가 없어 마지막 결과에 붙인다.
    const note = tail
      .flatMap((item) => (item.type === "message" ? [canonicalMessageText(item.content)] : []))
      .filter((text) => text.length > 0)
      .join("\n\n");
    const outcomes = new Map<string, McpToolOutcome>();
    outputs.forEach((output, index) => {
      const content = resultContent(output.output);
      if (note.length > 0 && index === outputs.length - 1) content.push({ type: "text", text: `\n[user note]\n${note}` });
      outcomes.set(output.call_id, { content, isError: output.is_error === true });
    });
    return outcomes;
  }

  private async openSession(
    request: CanonicalResponseRequest,
    selection: AcpModelSelection,
    seed: string,
    catalog: ReturnType<typeof toolCatalog>,
    replayed: boolean,
    signal: AbortSignal | undefined,
  ): Promise<BridgeSession> {
    await this.registry.makeRoom();
    const key = `br-${randomUUID()}`;
    const session = new BridgeSession({
      key,
      seed,
      tools: catalog.tools,
      names: catalog.names,
      limits: { holdMs: this.limits.holdMs, idleTtlMs: this.limits.idleTtlMs },
      mcp: this.mcp,
      onClosed: (closed) => this.registry.remove(closed),
    });
    this.registry.add(session);
    const registration = await this.mcp.register(key, session).catch((error: unknown) => { this.registry.remove(session); throw error; });
    // 열기 도중의 중단만 이 컨트롤러로 전한다. 열린 세션은 요청보다 오래 산다.
    const opening = new AbortController();
    const relay = (): void => opening.abort();
    if (signal?.aborted) relay(); else signal?.addEventListener("abort", relay, { once: true });
    try {
      const acp = await this.options.port.open({
        model: request.model,
        thoughtLevel: selection.thoughtLevel,
        cwd: os.tmpdir(),
        systemPrompt: [stripClaudeCodeIdentity(request.instructions ?? ""), bridgeNote(), ...(replayed ? [REPLAY_SYSTEM_NOTE] : [])].filter((part) => part.length > 0).join("\n\n"),
        mcpServers: [],
        toolOnly: {
          serverName: MCP_SERVER_NAME,
          url: registration.url,
          headers: { Authorization: `Bearer ${registration.token}` },
          toolNames: catalog.tools.map((tool) => tool.name),
          callTimeoutSeconds: this.limits.callTimeoutSeconds,
        },
        sessionKey: key,
        signal: opening.signal,
      });
      session.attach(acp);
      return session;
    } catch (error) {
      this.mcp.unregister(key);
      this.registry.remove(session);
      throw error;
    } finally {
      signal?.removeEventListener("abort", relay);
    }
  }

  private openFailure(error: unknown): AdapterResponse {
    if (error instanceof AcpModelUnavailableError) {
      // A 4xx: Claude Code does not retry a verdict a retry cannot change. The message names the model the session asked for.
      return failedResponse(400, "invalid_request_error", `${error.message} The agy account offers: ${error.availableModels.join(", ") || "no models"}. Pick another model or sign in to agy with an account that has it.`);
    }
    if (error instanceof AcpAuthRequiredError) {
      return failedResponse(401, "authentication_error", `${error.message} Run \`agy\` and sign in first.`);
    }
    return failedResponse(503, "api_error", error instanceof Error ? error.message : String(error));
  }

  /** 세션의 큐를 읽어 Messages 응답 하나분의 canonical 이벤트로 바꾼다. */
  private async *respond(
    session: BridgeSession,
    context: { readonly model: string; readonly baseChain: string; readonly signal: AbortSignal | undefined },
  ): AsyncGenerator<CanonicalResponseEvent> {
    const responseId = `msg_agy_${randomUUID().replace(/-/g, "")}`;
    const snapshot = (usage: { input_tokens: number; output_tokens: number; context_window?: number } | null = null) => ({ id: responseId, model: context.model, usage });
    yield { type: "response.created", response: snapshot() };

    const prefix = toolOnlyTitlePrefix(MCP_SERVER_NAME);
    let sequence = 0;
    let outputIndex = 0;
    let open: { readonly kind: "text" | "thought"; readonly id: string } | undefined;
    let text = "";
    const produced: string[] = [];
    const batch: BridgedCall[] = [];
    let finished = false;

    const usage = () => ({
      input_tokens: session.used,
      output_tokens: estimateTokens(produced.join(""), context.model),
      ...(session.contextWindow > 0 ? { context_window: session.contextWindow } : {}),
    });
    const closeRun = function* (): Generator<CanonicalResponseEvent> {
      if (open?.kind === "text") {
        yield { type: "response.output_text.done", item_id: open.id, output_index: outputIndex, content_index: 0, text: "" };
        outputIndex += 1;
      }
      open = undefined;
    };
    const fail = async function* (this: AgyAcpBridgeAdapter, message: string, type = "api_error"): AsyncGenerator<CanonicalResponseEvent> {
      yield* closeRun();
      yield { type: "response.failed", response: { ...snapshot(), error: { type, message } } };
      finished = true;
      await session.close(message);
    }.bind(this);

    try {
      for (;;) {
        const item = await session.channel.next(batch.length > 0 ? this.limits.coalesceMs : this.limits.silenceMs, context.signal);
        if (item === READ_ABORTED) return;
        if (item === READ_TIMEOUT) {
          if (batch.length === 0) { yield* fail(`agy produced no output for ${Math.round(this.limits.silenceMs / 1000)}s.`); return; }
          // 첫 호출 뒤 짧은 창이 닫혔다: 모은 호출을 tool_use로 내보내고 응답을 끝낸다. agy는 prompt를 연 채 결과를 기다린다.
          yield* closeRun();
          const calls: { callId: string; name: string; arguments: string }[] = [];
          for (const call of batch) {
            call.emitted = true;
            calls.push({ callId: call.callId, name: call.name, arguments: call.arguments });
            produced.push(call.arguments);
            const itemId = `agf_${sequence++}`;
            const base = { id: itemId, type: "function_call" as const, call_id: call.callId, name: call.name };
            yield { type: "response.output_item.added", output_index: outputIndex, item: { ...base, arguments: "" } };
            yield { type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: call.arguments };
            yield { type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, arguments: call.arguments };
            yield { type: "response.output_item.done", output_index: outputIndex, item: { ...base, arguments: call.arguments } };
            outputIndex += 1;
          }
          session.settle("awaiting_tools");
          this.registry.expect(session, chainAfterAssistant(context.baseChain, { text, calls }));
          yield { type: "response.completed", response: snapshot(usage()) };
          finished = true;
          return;
        }
        if (item.kind === "closed") { yield* fail(item.reason); return; }
        if (item.kind === "call") { batch.push(item.call); continue; }

        const event = item.event;
        switch (event.kind) {
          case "text": {
            // agy의 업스트림 오류 알림은 모델 출력이 아니다: 내보내지 않고 이 턴을 SSE 오류로 끝낸다(agy 재시도를 기다리지 않는다).
            const upstream = parseAgyUpstreamError(event.text);
            if (upstream) {
              const failure = upstreamFailure(upstream);
              wireLog("bridge.upstream_error", { session: session.key, status: failure.status, type: failure.type });
              yield* fail(failure.message, failure.type);
              return;
            }
            if (open?.kind !== "text") {
              yield* closeRun();
              open = { kind: "text", id: `agm_${sequence++}` };
              yield { type: "response.content_part.added", item_id: open.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "" } };
            }
            text += event.text;
            produced.push(event.text);
            yield { type: "response.output_text.delta", item_id: open.id, output_index: outputIndex, content_index: 0, delta: event.text };
            break;
          }
          case "thought": {
            if (open?.kind !== "thought") { yield* closeRun(); open = { kind: "thought", id: `agr_${sequence++}` }; }
            produced.push(event.text);
            yield { type: "response.reasoning_summary_text.delta", item_id: open.id, output_index: outputIndex, delta: event.text };
            break;
          }
          case "tool-start": {
            // 내장 도구가 실행되는 것은 차단이 뚫렸다는 뜻이다. 이 턴을 끝내고 세션을 버린다.
            if (!event.name.startsWith(prefix) && !AGY_INERT_TOOL_TITLES.has(event.name)) {
              wireLog("bridge.builtin_leak", { session: session.key, tool: event.name });
              yield* fail(`agy ran a built-in tool (${event.name}) that the bridge does not allow.`);
              return;
            }
            break;
          }
          case "usage":
          case "tool-end":
            break;
          case "exit": {
            yield* fail(`agy exited${event.detail ? `: ${event.detail}` : ""}`);
            return;
          }
          case "turn-end": {
            if (event.stopReason === "cancelled" || event.stopReason === "error") {
              yield* fail(event.stopReason === "cancelled" ? "agy cancelled the turn." : `agy failed the turn: ${event.detail ?? "unknown error"}`);
              return;
            }
            yield* closeRun();
            session.settle("idle");
            this.registry.expect(session, chainAfterAssistant(context.baseChain, { text, calls: [] }));
            const incomplete = event.stopReason === "max_tokens"
              ? { reason: "max_output_tokens" }
              : event.stopReason === "refusal" ? { reason: "content_filter" } : undefined;
            yield { type: "response.completed", response: { ...snapshot(usage()), ...(incomplete ? { incomplete } : {}) } };
            finished = true;
            return;
          }
        }
      }
    } finally {
      // 응답이 끝나지 못한 채 소비가 멈췄다(클라이언트 끊김·재시도): 이 세션의 부분 턴은 이어 갈 수 없다.
      if (!finished) await session.close("response ended before the agy turn did");
    }
  }
}

export function createAgyAcpBridge(options: AgyAcpBridgeOptions): AgyAcpBridge {
  return new AgyAcpBridgeAdapter(options);
}
