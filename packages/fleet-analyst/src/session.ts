import {
  createClaudeGatewaySdk,
  createEmbeddedMcpServer,
  defineTool,
  type ClaudeGatewayEffort,
  type ClaudeGatewayMessage,
  type ClaudeGatewayRun,
  type ClaudeGatewaySdk,
} from "@dotobokuri/core-agent/claude";

import { resolveAnalystSystemPrompt } from "./prompt.js";
import { AnalystTools } from "./tools.js";
import { redactTranscriptString } from "./transcript-indexer.js";
import type { AnalystEvent, AnalystSessionOptions } from "./types.js";

const ANALYST_MCP_SERVER = "session_analyst";
const GATEWAY_EFFORTS = new Set<ClaudeGatewayEffort>(["low", "medium", "high", "xhigh", "max"]);

/** Owns every per-analysis resource. Nothing survives dispose(). */
export class AnalystSession {
  private readonly options: AnalystSessionOptions;
  private readonly tools: AnalystTools;
  private sdk: ClaudeGatewaySdk | null = null;
  private run: ClaudeGatewayRun | null = null;
  /** 같은 분석 대화를 이어 가기 위한 자식 세션 id. 첫 턴이 알려 준다. */
  private resumeId: string | null = null;
  private started = false;
  private disposed = false;
  private turn: Promise<void> = Promise.resolve();
  private disposeFlight: Promise<void> | null = null;

  constructor(options: AnalystSessionOptions) {
    this.options = { ...options };
    this.tools = new AnalystTools(this.options);
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Session disposed");
    if (this.started) return;
    await this.tools.refresh();
    this.throwIfDisposed();
    const sdk = await (this.options.createSdk?.(this.sdkOptions()) ?? createClaudeGatewaySdk(this.sdkOptions()));
    if (this.disposed) {
      await sdk.dispose().catch(() => undefined);
      throw new Error("Session disposed");
    }
    this.sdk = sdk;
    this.started = true;
  }

  send(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed"));
    if (!this.started || !this.sdk) return Promise.reject(new Error("Session not started"));
    if (!text.trim()) return Promise.reject(new Error("Message required"));
    const run = this.turn.then(() => this.runTurn(text));
    this.turn = run.catch(() => undefined);
    return run;
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.disposeFlight = this.disposeResources();
    return this.disposeFlight;
  }

  private sdkOptions(): { readonly baseUrl: string; readonly models: readonly string[]; readonly env?: Readonly<Record<string, string>> } {
    return {
      baseUrl: this.options.baseUrl,
      models: [this.options.model],
      ...(this.options.env ? { env: { ...this.options.env } } : {}),
    };
  }

  private async runTurn(text: string): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) throw new Error("Session not started");
    const emit = (event: AnalystEvent): void => this.options.onEvent?.(event);
    // 분석가의 도구는 관측 대상 세션의 원문을 다룬다. 나가는 모든 문자열은 색인기가 쓰는 것과
    // 같은 규칙으로 가린다.
    const redact = redactTranscriptString;
    let run: ClaudeGatewayRun;
    try {
      run = await sdk.startTurn({
        prompt: text,
        model: this.options.model,
        systemPrompt: { mode: "replace", text: resolveAnalystSystemPrompt(this.options.language) },
        cwd: this.options.cwd,
        // 관측자는 이 기계를 건드리지 않는다. 내장 도구를 전부 없애면 아래 MCP 도구만 남는다 —
        // 앞선 ACP 권한 분류기가 도구 이름을 추측해 걸러내던 일을 구조가 대신한다.
        tools: [],
        mcpServers: { [ANALYST_MCP_SERVER]: this.mcpServer() },
        allowedTools: this.tools.specs().map((spec) => `mcp__${ANALYST_MCP_SERVER}__${spec.id}`),
        permissionMode: "dontAsk",
        // 텍스트와 사고를 흘려 보내려면 부분 메시지가 필요하다.
        includePartialMessages: true,
        ...(this.effort() === undefined ? {} : { effort: this.effort()! }),
        ...(this.resumeId === null ? {} : { resume: this.resumeId }),
      });
    } catch (error) {
      emit({ type: "error", error: { code: "analysis_error", message: redact(errorMessage(error)) } });
      throw error;
    }
    this.run = run;
    const toolNames = new Map<string, string>();
    try {
      for await (const event of run) {
        if (typeof event.session_id === "string" && this.resumeId === null) this.resumeId = event.session_id;
        for (const mapped of toAnalystEvents(event, toolNames, redact)) emit(mapped);
      }
    } catch (error) {
      if (this.disposed) return;
      emit({ type: "error", error: { code: "analysis_error", message: redact(errorMessage(error)) } });
      throw error;
    } finally {
      if (this.run === run) this.run = null;
    }
  }

  /** 분석 도구는 이 프로세스 안에서 돈다. 자식은 이름으로 부를 뿐 실행하지 않는다. */
  private mcpServer(): ReturnType<typeof createEmbeddedMcpServer> {
    return createEmbeddedMcpServer({
      name: ANALYST_MCP_SERVER,
      tools: this.tools.specs().map((spec) => defineTool(
        spec.id,
        spec.description,
        spec.parameters,
        async (args) => ({
          content: [{ type: "text", text: JSON.stringify(await spec.execute(args)) }],
        }),
      )),
    });
  }

  private effort(): ClaudeGatewayEffort | undefined {
    const effort = this.options.effort;
    return effort !== undefined && GATEWAY_EFFORTS.has(effort as ClaudeGatewayEffort)
      ? effort as ClaudeGatewayEffort
      : undefined;
  }

  private async disposeResources(): Promise<void> {
    this.run?.close();
    this.run = null;
    await this.turn.catch(() => undefined);
    const sdk = this.sdk;
    this.sdk = null;
    this.started = false;
    await sdk?.dispose().catch(() => undefined);
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new Error("Session disposed");
  }
}

/**
 * 자식이 흘리는 메시지를 분석가의 이벤트로 옮긴다.
 *
 * 모양은 실측으로 고정했다. 답변 텍스트와 사고가 같은 `content_block_delta` 자리로 오되
 * `text_delta`와 `thinking_delta`로 갈리며, 분석가는 앞선 ACP 경로에서 둘 다 별개 이벤트로
 * 내보냈으므로 여기서도 둘 다 옮긴다. `artifact` 이벤트는 이 경로가 아니라 publish_artifact
 * 도구 핸들러가 직접 낸다.
 */
export function toAnalystEvents(
  event: ClaudeGatewayMessage,
  toolNames: Map<string, string>,
  redact: (value: string) => string,
): readonly AnalystEvent[] {
  if (event.type === "stream_event") {
    const inner = record(event.event);
    if (inner.type !== "content_block_delta") return [];
    const delta = record(inner.delta);
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      return [{ type: "chunk", text: redact(delta.text) }];
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      return [{ type: "thought", text: redact(delta.thinking) }];
    }
    return [];
  }
  if (event.type === "assistant") {
    const events: AnalystEvent[] = [];
    for (const block of blocks(event.message)) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      if (typeof block.id === "string") toolNames.set(block.id, name);
      events.push({ type: "tool", title: redact(name), status: "running" });
    }
    return events;
  }
  if (event.type === "user") {
    const events: AnalystEvent[] = [];
    for (const block of blocks(event.message)) {
      if (block.type !== "tool_result") continue;
      const name = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) ?? "tool" : "tool";
      events.push({ type: "tool", title: redact(name), status: block.is_error === true ? "error" : "done" });
    }
    return events;
  }
  if (event.type === "result") {
    if (event.is_error === true) {
      const detail = typeof event.result === "string" ? event.result : "Analysis turn failed";
      return [{ type: "error", error: { code: "analysis_error", message: redact(detail) } }];
    }
    return [{ type: "complete" }];
  }
  return [];
}

function blocks(message: unknown): readonly Record<string, unknown>[] {
  const content = record(message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
