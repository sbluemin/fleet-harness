import { EventEmitter } from "node:events";

import {
  createClaudeExecutionLoop,
  createClaudeGatewaySdk,
  type ClaudeExecutionEvent,
  type ClaudeExecutionLoop,
  type ClaudeGatewayEffort,
  type ClaudeGatewaySdk,
  type ClaudeGatewayServedMcpServer,
} from "@dotobokuri/core-agent/claude";
import type { CoworkAgentClient, CoworkConnectOptions, CoworkConnector } from "@dotobokuri/fleet-wiki/cowork";

/** 게이트웨이 강도 사다리. 여기 없는 값은 싣지 않는다 — 사용자가 고르지 않은 강도로 도는 것보다 낫다. */
const GATEWAY_EFFORTS = new Set<ClaudeGatewayEffort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * 한 턴이 아무 종료 신호 없이 늘어지는 것을 끊는 상한.
 *
 * 공통 루프가 이 시간 안에 결과를 보지 못하면 워치독으로 정산한다.
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
  /**
   * 테스트 seam. 커넥터가 조립한 생성 인자를 그대로 받는다 — 인자 없이 받으면 조립 자체가 검증
   * 밖으로 나간다.
   */
  readonly createSdk?: (options: {
    readonly baseUrl: string;
    readonly models: readonly string[];
  }) => Promise<ClaudeGatewaySdk>;
}

/**
 * Cowork를 Console의 AI Gateway 위에서 돌리는 커넥터.
 *
 * fleet-wiki는 provider 조립을 모른다 — 커넥터는 반드시 호스트가 소유한다.
 */
export function createCoworkGatewayConnector(deps: CoworkGatewayAdapterDeps): CoworkConnector {
  return {
    async connect(options: CoworkConnectOptions): Promise<CoworkAgentClient> {
      const baseUrl = deps.baseUrl();
      // 포트를 추측해 자식을 띄우면 첫 턴에서야 알 수 없는 이유로 죽는다.
      if (!baseUrl) throw new Error("cowork_gateway_unavailable");
      const model = options.model && options.model.length > 0 ? options.model : "sonnet";
      const client = new CoworkGatewayClient();
      const loop = createClaudeExecutionLoop({
        createSdk: () => {
          const create = { baseUrl, models: [model] };
          return deps.createSdk?.(create) ?? createClaudeGatewaySdk(create);
        },
        buildTurn: () => {
          const effort = options.effort;
          const served = toServedMcpServers(options.mcpServers);
          return {
            model,
            systemPrompt: { mode: "replace" as const, text: options.systemPrompt },
            cwd: options.cwd,
            disallowedTools: COWORK_DISALLOWED_TOOLS,
            // 위키 도구는 호스트가 이미 띄운 HTTP MCP 엔드포인트로 온다. 이것을 싣지 않으면 자식은
            // 시스템 프롬프트가 말하는 도구 이름을 부르지만 그런 도구가 없어 그대로 턴이 끝난다.
            servedMcpServers: served,
            // dontAsk는 사전승인되지 않은 도구를 묻지 않고 거부한다 — 노출한 도구는 전부 승인해 둔다.
            allowedTools: served.flatMap((server) => options.allowedToolIds.map((id) => `mcp__${server.name}__${id}`)),
            permissionMode: "dontAsk" as const,
            includePartialMessages: true,
            ...(effort && GATEWAY_EFFORTS.has(effort as ClaudeGatewayEffort) ? { effort: effort as ClaudeGatewayEffort } : {}),
          };
        },
        continuation: { kind: "oneshot" },
        settlement: { kind: "result-required", watchdogMs: TURN_WATCHDOG_MS },
        onEvent: (event) => client.publish(event),
      });
      client.bind(loop);
      await loop.start();
      return client;
    },
  };
}

class CoworkGatewayClient extends EventEmitter implements CoworkAgentClient {
  private loop: ClaudeExecutionLoop | null = null;
  /** 이번 턴을 취소한 뒤에 루프가 내는 종점 정산·이터레이터 거절은 조용히 삼킨다. */
  private canceledTurn = false;

  bind(loop: ClaudeExecutionLoop): void {
    this.loop = loop;
  }

  publish(event: ClaudeExecutionEvent): void {
    if (this.canceledTurn && event.kind === "result") return;
    if (event.kind === "text") {
      this.emit("messageChunk", event.text);
      return;
    }
    if (event.kind === "thinking") return;
    if (event.kind === "tool-start") {
      this.emit("toolCall", event.name, "running");
      return;
    }
    if (event.kind === "tool-end") {
      this.emit("toolCallUpdate", event.name ?? "tool", event.isError ? "error" : "done");
      return;
    }
    if (event.source === "incomplete") {
      this.emit("error", { message: "cowork_turn_incomplete" });
      return;
    }
    if (event.source === "watchdog") {
      this.emit("error", { message: "cowork_turn_timeout" });
      return;
    }
    if (event.isError) {
      this.emit("error", { message: event.detail ?? "cowork_turn_failed" });
      return;
    }
    this.emit("promptComplete");
  }

  async sendMessage(content: string): Promise<void> {
    this.canceledTurn = false;
    try {
      await this.requireLoop().run(content);
    } catch (error) {
      if (this.canceledTurn) return;
      throw disposedError(error);
    }
  }

  async cancelPrompt(): Promise<void> {
    this.canceledTurn = true;
    this.loop?.cancel();
  }

  async disconnect(): Promise<void> {
    await this.loop?.dispose();
  }

  private requireLoop(): ClaudeExecutionLoop {
    if (this.loop === null) throw new Error("cowork_session_disposed");
    return this.loop;
  }
}

function disposedError(error: unknown): unknown {
  return error instanceof Error && error.message === "Session disposed"
    ? new Error("cowork_session_disposed")
    : error;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
