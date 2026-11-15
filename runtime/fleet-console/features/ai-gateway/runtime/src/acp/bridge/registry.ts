import { randomUUID } from "node:crypto";

import type { AcpPromptBlock, AcpSession, AcpSessionEvent } from "../contract.js";
import { wireLog } from "../../transport/wire-log.js";
import type { BridgeMcpServer, BridgeToolDef, McpSessionHandler, McpToolOutcome, PendingMcpCall } from "./mcp-server.js";

/**
 * 브리지 세션: 살아 있는 `agy acp` 자식 하나와, 그 위에서 이어지는 Messages 대화 하나.
 *
 * 한 ACP `session/prompt`가 여러 Messages 응답에 걸칠 수 있다. 모델이 도구를 부르면 agy는 MCP 응답을 기다리며
 * prompt를 연 채로 멈추고, Messages 응답은 `tool_use`로 끝난다. 다음 요청의 tool_result가 그 MCP 호출을 풀고 같은
 * prompt의 이벤트가 이어서 흐른다. 그래서 ACP 이벤트와 MCP 호출을 한 큐(`BridgeChannel`)에 모아 응답이 번갈아 읽는다.
 */

/** 브리지가 Claude Code에 내보내는 도구 호출 하나. */
export interface BridgedCall {
  /** Messages `tool_use` id. */
  readonly callId: string;
  /** Claude Code의 도구 이름(MCP로 노출한 이름이 별칭이면 되돌린 것). */
  readonly name: string;
  /** 인자 JSON 원문. */
  readonly arguments: string;
  readonly mcp: PendingMcpCall;
  emitted: boolean;
}

export type BridgeItem =
  | { readonly kind: "acp"; readonly event: AcpSessionEvent }
  | { readonly kind: "call"; readonly call: BridgedCall }
  | { readonly kind: "closed"; readonly reason: string };

export type BridgeSessionState = "opening" | "idle" | "streaming" | "awaiting_tools" | "closed";

export const READ_TIMEOUT: unique symbol = Symbol("timeout");
export const READ_ABORTED: unique symbol = Symbol("aborted");

export class BridgeChannel {
  private readonly items: BridgeItem[] = [];
  private wake: (() => void) | undefined;

  push(item: BridgeItem): void {
    this.items.push(item);
    this.wake?.();
  }

  clear(): void {
    this.items.length = 0;
  }

  async next(timeoutMs: number, signal?: AbortSignal): Promise<BridgeItem | typeof READ_TIMEOUT | typeof READ_ABORTED> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const item = this.items.shift();
      if (item) return item;
      if (signal?.aborted) return READ_ABORTED;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return READ_TIMEOUT;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        const onAbort = (): void => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.wake = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(); };
      });
      this.wake = undefined;
    }
  }
}

export interface BridgeSessionLimits {
  /** 도구 결과를 기다리는 최대 시간. agy의 MCP 호출 한도(`callTimeoutSeconds`)보다 짧아야 한다. */
  readonly holdMs: number;
  /** 응답이 끝난 세션을 살려 두는 시간. 그 뒤 다음 요청은 새 세션 + 이력 재주입으로 시작한다. */
  readonly idleTtlMs: number;
}

export interface BridgeSessionInit {
  readonly key: string;
  readonly seed: string;
  readonly tools: readonly BridgeToolDef[];
  /** MCP 노출 이름 → Claude Code 도구 이름. */
  readonly names: ReadonlyMap<string, string>;
  readonly limits: BridgeSessionLimits;
  readonly mcp: BridgeMcpServer;
  readonly onClosed: (session: BridgeSession) => void;
}

const CLOSED_BY_BRIDGE: McpToolOutcome = {
  content: [{ type: "text", text: "The bridge closed this session before the tool result arrived." }],
  isError: true,
};

export class BridgeSession implements McpSessionHandler {
  readonly channel = new BridgeChannel();
  readonly pending = new Map<string, BridgedCall>();
  readonly key: string;
  readonly seed: string;
  /** 다음 요청이 이 세션으로 이어지려면 그 요청 이력이 가져야 하는 체인. 응답이 끝날 때 갱신한다. */
  expectNext: string | undefined;
  lastUsedAt = Date.now();
  /** `usage_update`가 마지막으로 알린 컨텍스트 점유와 창. */
  used = 0;
  contextWindow = 0;
  private current: BridgeSessionState = "opening";
  private acp: AcpSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pumpDone: Promise<void> = Promise.resolve();

  constructor(private readonly init: BridgeSessionInit) {
    this.key = init.key;
    this.seed = init.seed;
  }

  get state(): BridgeSessionState { return this.current; }

  attach(acp: AcpSession): void {
    this.acp = acp;
    this.setState("idle");
  }

  tools(): readonly BridgeToolDef[] { return this.init.tools; }

  onCall(mcp: PendingMcpCall): void {
    const call: BridgedCall = {
      callId: `toolu_agy_${randomUUID().replace(/-/g, "")}`,
      name: this.init.names.get(mcp.name) ?? mcp.name,
      arguments: JSON.stringify(mcp.args),
      mcp,
      emitted: false,
    };
    this.pending.set(call.callId, call);
    this.channel.push({ kind: "call", call });
  }

  /** agy가 보류 호출을 포기했다(한도 초과·취소·연결 끊김). 이 세션은 이어 갈 수 없다 — 이후 출력도 내보내지 않는다. */
  onAbandon(_call: PendingMcpCall, reason: string): void {
    wireLog("bridge.call_abandoned", { session: this.key, reason });
    void this.close(`agy gave up waiting for a tool result (${reason})`);
  }

  /** 새 `session/prompt`를 열고 그 이벤트를 큐로 흘린다. */
  async startPrompt(blocks: readonly AcpPromptBlock[]): Promise<void> {
    if (!this.acp || this.current === "closed") throw new Error("The bridge session is closed.");
    await this.pumpDone;
    this.channel.clear();
    this.setState("streaming");
    const stream = this.acp.prompt(blocks);
    this.pumpDone = (async () => {
      try {
        for await (const event of stream) {
          if (this.current === "closed") return;
          wireLog("bridge.acp", { session: this.key, kind: event.kind, ...("text" in event ? { chars: event.text.length } : {}), ...("name" in event ? { name: event.name } : {}) });
          if (event.kind === "usage") { this.used = event.usage.usedTokens; this.contextWindow = event.usage.contextWindow; }
          this.channel.push({ kind: "acp", event });
          if (event.kind === "exit") void this.close(`agy exited${event.detail ? `: ${event.detail}` : ""}`);
        }
      } catch (error) {
        this.channel.push({ kind: "acp", event: { kind: "turn-end", stopReason: "error", detail: error instanceof Error ? error.message : String(error) } });
      }
    })();
  }

  /** 보류 호출을 Claude Code의 결과로 푼다. 응답은 이어서 이 큐를 읽는다. */
  resolveCalls(outcomes: ReadonlyMap<string, McpToolOutcome>): void {
    this.setState("streaming");
    for (const [callId, outcome] of outcomes) {
      const call = this.pending.get(callId);
      this.pending.delete(callId);
      call?.mcp.settle(outcome);
    }
  }

  /** 응답이 끝났다: 도구 호출로 끝났으면 `awaiting_tools`, 모델 턴이 끝났으면 `idle`. */
  settle(next: "idle" | "awaiting_tools"): void {
    if (this.current === "closed") return;
    this.setState(next);
  }

  async close(reason: string): Promise<void> {
    if (this.current === "closed") return;
    this.setState("closed");
    wireLog("bridge.session_closed", { session: this.key, reason });
    for (const call of this.pending.values()) call.mcp.settle(CLOSED_BY_BRIDGE);
    this.pending.clear();
    this.channel.push({ kind: "closed", reason });
    this.init.mcp.unregister(this.key);
    this.init.onClosed(this);
    const acp = this.acp;
    if (acp) {
      await acp.cancel().catch(() => undefined);
      await acp.close().catch(() => undefined);
    }
  }

  private setState(next: BridgeSessionState): void {
    this.current = next;
    this.lastUsedAt = Date.now();
    clearTimeout(this.timer);
    this.timer = undefined;
    const limit = next === "awaiting_tools" ? this.init.limits.holdMs : next === "idle" ? this.init.limits.idleTtlMs : undefined;
    if (limit !== undefined) {
      const reason = next === "awaiting_tools" ? "tool result did not arrive in time" : "idle session expired";
      this.timer = setTimeout(() => { void this.close(reason); }, limit);
      this.timer.unref();
    }
  }
}

/** 지문 체인 → 세션 인덱스, 세션 수 상한. */
export class SessionRegistry {
  private readonly sessions = new Set<BridgeSession>();
  private readonly index = new Map<string, BridgeSession>();

  constructor(private readonly maxSessions: number) {}

  add(session: BridgeSession): void { this.sessions.add(session); }

  /** 다음 요청이 이 체인으로 들어오면 `session`이 이어 간다. */
  expect(session: BridgeSession, chain: string): void {
    this.unexpect(session);
    session.expectNext = chain;
    this.index.set(chain, session);
  }

  unexpect(session: BridgeSession): void {
    const key = session.expectNext;
    if (key !== undefined && this.index.get(key) === session) this.index.delete(key);
    session.expectNext = undefined;
  }

  lookup(chain: string): BridgeSession | undefined {
    const session = this.index.get(chain);
    return session && session.state !== "closed" ? session : undefined;
  }

  remove(session: BridgeSession): void {
    this.unexpect(session);
    this.sessions.delete(session);
  }

  /** 새 세션 자리를 만든다: 상한이면 가장 오래 쓰지 않은, 응답 중이 아닌 세션부터 닫는다. */
  async makeRoom(): Promise<void> {
    while (this.sessions.size >= this.maxSessions) {
      const victim = [...this.sessions]
        .filter((session) => session.state !== "streaming" && session.state !== "opening")
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!victim) return;
      await victim.close("evicted: too many bridge sessions");
    }
  }

  async closeAll(reason: string): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close(reason)));
  }
}
