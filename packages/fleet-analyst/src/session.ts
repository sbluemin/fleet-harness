import {
  createClaudeExecutionLoop,
  createClaudeGatewaySdk,
  createEmbeddedMcpServer,
  defineTool,
  type ClaudeExecutionEvent,
  type ClaudeExecutionLoop,
  type ClaudeExecutionTurn,
  type ClaudeGatewayEffort,
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
  private readonly loop: ClaudeExecutionLoop;
  private started = false;
  private disposed = false;

  constructor(options: AnalystSessionOptions) {
    this.options = { ...options };
    this.tools = new AnalystTools(this.options);
    this.loop = createClaudeExecutionLoop({
      createSdk: async () => this.options.createSdk?.(this.sdkOptions()) ?? createClaudeGatewaySdk(this.sdkOptions()),
      buildTurn: () => this.buildTurn(),
      continuation: { kind: "resume-child" },
      settlement: { kind: "result" },
      onEvent: (event) => {
        for (const mapped of toAnalystEvents(event)) this.options.onEvent?.(mapped);
      },
    });
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Session disposed");
    if (this.started) return;
    await this.tools.refresh();
    if (this.disposed) {
      await this.loop.dispose();
      throw new Error("Session disposed");
    }
    await this.loop.start();
    if (this.disposed) {
      await this.loop.dispose();
      throw new Error("Session disposed");
    }
    this.started = true;
  }

  send(text: string): Promise<void> {
    return this.loop.run(text).catch((error: unknown) => {
      if (this.disposed) throw error;
      const message = errorMessage(error);
      if (message === "Session not started" || message === "Message required" || message === "Session disposed") {
        throw error;
      }
      this.options.onEvent?.({ type: "error", error: { code: "analysis_error", message: redactTranscriptString(message) } });
      throw error;
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.loop.dispose();
  }

  private sdkOptions(): { readonly baseUrl: string; readonly models: readonly string[]; readonly env?: Readonly<Record<string, string>> } {
    return {
      baseUrl: this.options.baseUrl,
      models: [this.options.model],
      ...(this.options.env ? { env: { ...this.options.env } } : {}),
    };
  }

  private buildTurn(): ClaudeExecutionTurn {
    return {
      model: this.options.model,
      systemPrompt: { mode: "replace", text: resolveAnalystSystemPrompt(this.options.language) },
      cwd: this.options.cwd,
      // 관측자는 이 기계를 건드리지 않는다. 내장 도구를 전부 없애면 아래 MCP 도구만 남는다.
      tools: [],
      mcpServers: { [ANALYST_MCP_SERVER]: this.mcpServer() },
      allowedTools: this.tools.specs().map((spec) => `mcp__${ANALYST_MCP_SERVER}__${spec.id}`),
      permissionMode: "dontAsk",
      // 텍스트와 사고를 흘려 보내려면 부분 메시지가 필요하다.
      includePartialMessages: true,
      ...(this.effort() === undefined ? {} : { effort: this.effort()! }),
    };
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
}

/**
 * 정규화된 실행 이벤트를 분석가의 이벤트로 옮긴다.
 *
 * 답변 텍스트와 사고는 별개로 나간다. `artifact` 이벤트는 이 경로가 아니라
 * publish_artifact 도구 핸들러가 직접 낸다.
 */
export function toAnalystEvents(event: ClaudeExecutionEvent): readonly AnalystEvent[] {
  const redact = redactTranscriptString;
  switch (event.kind) {
    case "text":
      return [{ type: "chunk", text: redact(event.text) }];
    case "thinking":
      return [{ type: "thought", text: redact(event.text) }];
    case "tool-start":
      return [{ type: "tool", title: redact(event.name), status: "running" }];
    case "tool-end":
      return [{ type: "tool", title: redact(event.name ?? "tool"), status: event.isError ? "error" : "done" }];
    case "result":
      if (event.isError) {
        return [{ type: "error", error: { code: "analysis_error", message: redact(event.detail ?? "Analysis turn failed") } }];
      }
      return [{ type: "complete" }];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
