import { EventEmitter } from "node:events";

import type { AgentHost, AgentEvent, AgentSession, AgentEffort } from "@fleet-console/sdk/agent";
import type { CoworkAgentClient, CoworkConnectOptions, CoworkConnector } from "./index.js";

/** 게이트웨이 강도 사다리. 여기 없는 값은 싣지 않는다 — 사용자가 고르지 않은 강도로 도는 것보다 낫다. */
const GATEWAY_EFFORTS = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * 한 턴이 아무 종료 신호 없이 늘어지는 것을 끊는 상한.
 *
 * 공통 루프가 이 시간 안에 결과를 보지 못하면 워치독으로 정산한다.
 */
const TURN_WATCHDOG_MS = 10 * 60 * 1000;

export interface CoworkGatewayAdapterDeps {
  readonly agent: AgentHost;
}

export function createCoworkGatewayConnector(deps: CoworkGatewayAdapterDeps): CoworkConnector {
  return {
    async connect(options: CoworkConnectOptions): Promise<CoworkAgentClient> {
      const client = new CoworkGatewayClient();
      const session = await deps.agent.createSession({
        model: options.model || "sonnet",
        ...(options.effort && GATEWAY_EFFORTS.has(options.effort as AgentEffort) ? { effort: options.effort as AgentEffort } : {}),
        systemPrompt: options.systemPrompt,
        tools: { builtins: [], custom: options.tools },
        continuation: "oneshot",
        settlement: "result-required",
        timeoutMs: TURN_WATCHDOG_MS,
        onEvent: (event) => client.publish(event),
      });
      client.bind(session);
      return client;
    },
  };
}

class CoworkGatewayClient extends EventEmitter implements CoworkAgentClient {
  private loop: AgentSession | null = null;
  /** 이번 턴을 취소한 뒤에 루프가 내는 종점 정산·이터레이터 거절은 조용히 삼킨다. */
  private canceledTurn = false;

  bind(loop: AgentSession): void {
    this.loop = loop;
  }

  publish(event: AgentEvent): void {
    if (event.kind === "cancelled") return;
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
      // 라우터가 켜지지 않은 모델을 거절하면 사용자가 고칠 수 있는 원인이다 — 서비스가 클라이언트에
      // 넘길 수 있는 코드로 분류하고, 원문은 로그용 detail로 함께 싣는다.
      if (event.detail && /model is not enabled/iu.test(event.detail)) {
        this.emit("error", { message: "cowork_model_not_enabled", detail: event.detail });
        return;
      }
      this.emit("error", { message: event.detail ?? "cowork_turn_failed" });
      return;
    }
    this.emit("promptComplete");
  }

  async sendMessage(content: string): Promise<void> {
    this.canceledTurn = false;
    try {
      await this.requireLoop().send(content);
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

  private requireLoop(): AgentSession {
    if (this.loop === null) throw new Error("cowork_session_disposed");
    return this.loop;
  }
}

function disposedError(error: unknown): unknown {
  return error instanceof Error && error.message === "Session disposed"
    ? new Error("cowork_session_disposed")
    : error;
}
