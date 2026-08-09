import { EventEmitter } from "node:events";

import { createClaudeGatewaySdk, type ClaudeGatewayEffort, type ClaudeGatewayRun, type ClaudeGatewaySdk, type ClaudeGatewayServedMcpServer } from "@dotobokuri/core-agent/claude";
import type { CoworkAgentClient, CoworkConnectOptions, CoworkConnector } from "@dotobokuri/fleet-wiki/cowork";

/** 게이트웨이 강도 사다리. 여기 없는 값은 싣지 않는다 — 사용자가 고르지 않은 강도로 도는 것보다 낫다. */
const GATEWAY_EFFORTS = new Set<ClaudeGatewayEffort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * 한 턴이 아무 종료 신호 없이 늘어지는 것을 끊는 상한.
 *
 * 이터레이터가 결과 없이 끝나거나 이 시간을 넘기면 오류로 올린다. 조용히 멈춘 대화는 사용자에게
 * "생각 중"과 구별되지 않아 영원히 기다리게 되므로, 판정은 시끄러워야 한다.
 */
const TURN_WATCHDOG_MS = 10 * 60 * 1000;

/**
 * 문맥에서 제거하는 내장 툴.
 *
 * `tools: []`로 한 번에 지우고 싶지만 쓸 수 없다 — 실측하면 그 필드는 HTTP MCP 서버의 툴까지
 * 함께 없애 버려서 Cowork가 자기 위키 도구를 잃는다. 그래서 파일·셸·네트워크·에이전트 생성 계열을
 * 이름으로 빼고, 남는 나머지는 `permissionMode: "dontAsk"`가 호출 시점에 거부한다.
 */
const COWORK_DISALLOWED_TOOLS = [
  "Bash", "BashOutput", "KillShell",
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch",
  "Task", "Agent", "Workflow", "Skill", "SendMessage",
  "EnterWorktree", "ExitWorktree",
  "TodoWrite", "SlashCommand", "Artifact",
];

export interface CoworkGatewayAdapterDeps {
  /** Console이 서빙 중인 AI Gateway의 절대 URL. 리슨 전이면 null. */
  readonly baseUrl: () => string | null;
}

/**
 * Cowork를 Console의 AI Gateway 위에서 돌리는 커넥터.
 *
 * 예전에는 ACP 클라이언트를 그대로 넘겼다. fleet-wiki는 그때도 provider 조립을 몰랐고 지금도
 * 모른다 — 바뀐 것은 호스트가 조립하는 대상뿐이다.
 */
export function createCoworkGatewayConnector(deps: CoworkGatewayAdapterDeps): CoworkConnector {
  return {
    async connect(options: CoworkConnectOptions): Promise<CoworkAgentClient> {
      const baseUrl = deps.baseUrl();
      // 포트를 추측해 자식을 띄우면 첫 턴에서야 알 수 없는 이유로 죽는다.
      if (!baseUrl) throw new Error("cowork_gateway_unavailable");
      const model = options.model && options.model.length > 0 ? options.model : "sonnet";
      const sdk = await createClaudeGatewaySdk({ baseUrl, models: [model] });
      return new CoworkGatewayClient(sdk, options, model);
    },
  };
}

class CoworkGatewayClient extends EventEmitter implements CoworkAgentClient {
  private run: ClaudeGatewayRun | null = null;
  private resumeId: string | null = null;
  private disposed = false;

  constructor(
    private readonly sdk: ClaudeGatewaySdk,
    private readonly options: CoworkConnectOptions,
    private readonly model: string,
  ) {
    super();
  }

  async sendMessage(content: string): Promise<void> {
    if (this.disposed) throw new Error("cowork_session_disposed");
    const effort = this.options.effort;
    const served = toServedMcpServers(this.options.mcpServers);
    const run = await this.sdk.startTurn({
      prompt: content,
      model: this.model,
      systemPrompt: { mode: "replace", text: this.options.systemPrompt },
      cwd: this.options.cwd,
      disallowedTools: COWORK_DISALLOWED_TOOLS,
      // 위키 도구는 호스트가 이미 띄운 HTTP MCP 엔드포인트로 온다. 이것을 싣지 않으면 자식은
      // 시스템 프롬프트가 말하는 도구 이름을 부르지만 그런 도구가 없어 그대로 턴이 끝난다.
      servedMcpServers: served,
      // dontAsk는 사전승인되지 않은 도구를 묻지 않고 거부한다 — 노출한 도구는 전부 승인해 둔다.
      allowedTools: served.flatMap((server) => this.options.allowedToolIds.map((id) => `mcp__${server.name}__${id}`)),
      permissionMode: "dontAsk",
      includePartialMessages: true,
      ...(effort && GATEWAY_EFFORTS.has(effort as ClaudeGatewayEffort) ? { effort: effort as ClaudeGatewayEffort } : {}),
      ...(this.resumeId === null ? {} : { resume: this.resumeId }),
    });
    this.run = run;
    await this.consume(run);
  }

  async cancelPrompt(): Promise<void> {
    this.run?.close();
    this.run = null;
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.run?.close();
    this.run = null;
    await this.sdk.dispose().catch(() => undefined);
  }

  /**
   * 한 턴을 소비하고 정확히 한 번 결말을 낸다.
   *
   * 이터레이터가 끝났다는 사실만으로 성공을 알리지 않는다. 인식 가능한 종료 결과를 보지 못한 채
   * 끝나면 그것은 조용한 실패이고, 조용한 실패는 사용자에게 멈춘 화면으로만 보인다.
   */
  private async consume(run: ClaudeGatewayRun): Promise<void> {
    const toolNames = new Map<string, string>();
    let settled = false;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      if (error) this.emit("error", { message: error });
      else this.emit("promptComplete");
    };
    const watchdog = setTimeout(() => { run.close(); finish("cowork_turn_timeout"); }, TURN_WATCHDOG_MS);
    watchdog.unref?.();
    try {
      for await (const event of run) {
        if (typeof event.session_id === "string" && this.resumeId === null) this.resumeId = event.session_id;
        this.publish(event, toolNames, finish);
      }
      finish(settled ? undefined : "cowork_turn_incomplete");
    } catch (error) {
      if (!this.disposed) finish(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(watchdog);
      if (this.run === run) this.run = null;
    }
  }

  private publish(event: Record<string, unknown>, toolNames: Map<string, string>, finish: (error?: string) => void): void {
    const type = event.type;
    if (type === "stream_event") {
      const inner = record(event.event);
      if (inner.type !== "content_block_delta") return;
      const delta = record(inner.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        this.emit("messageChunk", delta.text);
      }
      return;
    }
    if (type === "assistant") {
      for (const block of blocks(event.message)) {
        if (block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "tool";
        if (typeof block.id === "string") toolNames.set(block.id, name);
        this.emit("toolCall", name, "running");
      }
      return;
    }
    if (type === "user") {
      for (const block of blocks(event.message)) {
        if (block.type !== "tool_result") continue;
        const name = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) ?? "tool" : "tool";
        this.emit("toolCallUpdate", name, block.is_error === true ? "error" : "done");
      }
      return;
    }
    if (type === "result") {
      finish(event.is_error === true ? (typeof event.result === "string" ? event.result : "cowork_turn_failed") : undefined);
    }
  }
}

/**
 * fleet-wiki는 provider를 몰라야 하므로 커넥터 계약에서 MCP 기술자를 `unknown`으로 넘긴다.
 * 그 모양을 아는 것은 조립한 호스트뿐이라, 좁히는 일도 여기서 한다.
 */
function toServedMcpServers(values: readonly unknown[]): readonly ClaudeGatewayServedMcpServer[] {
  return values.flatMap((value) => {
    const server = record(value);
    if (typeof server.name !== "string" || typeof server.url !== "string") return [];
    const headers = Array.isArray(server.headers)
      ? server.headers.map(record).flatMap((header) => typeof header.name === "string" && typeof header.value === "string"
        ? [{ name: header.name, value: header.value }] : [])
      : [];
    return [{
      name: server.name,
      url: server.url,
      ...(headers.length ? { headers } : {}),
      ...(typeof server.toolTimeoutSeconds === "number" ? { toolTimeoutSeconds: server.toolTimeoutSeconds } : {}),
    }];
  });
}

function blocks(message: unknown): readonly Record<string, unknown>[] {
  const content = record(message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
