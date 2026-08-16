/**
 * 이 리포에서 `@anthropic-ai/claude-agent-sdk`를 부르는 유일한 신규 지점.
 *
 * `scripts/check-claude-agent-sdk-boundary.mjs`가 이 파일 외의 import와 manifest 선언을 매 PR에
 * 차단한다. 여기서 내보내는 모든 함수의 시그니처는 `./contracts.js`와 내장 타입으로만 이루어진다 —
 * vendor 타입이 형제 모듈의 `.d.ts`로 새면 소비자 해석 그래프가 다시 vendor를 요구하게 되고,
 * 그것이 이 패키지가 막으려는 바로 그 상태다.
 */
import {
  createSdkMcpServer as vendorCreateSdkMcpServer,
  getSessionInfo as vendorGetSessionInfo,
  query as vendorQuery,
  tool as vendorTool,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeGatewayContextUsage,
  ClaudeGatewayMcpServer,
  ClaudeGatewayMessage,
  ClaudeGatewayRun,
  ClaudeGatewaySession,
  ClaudeGatewayTool,
  ClaudeGatewayToolExtras,
  ClaudeGatewayToolResult,
} from "./contracts.js";

/** 이미 조립이 끝난 vendor `query()` 인자. 조립 책임은 `./sdk.ts`에 있다. */
export interface VendorQueryInput {
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** 세션용 vendor `query()` 인자. 프롬프트는 이 모듈이 만든 입력 스트림이 대신한다. */
export interface VendorSessionInput {
  readonly options: Readonly<Record<string, unknown>>;
}

/** vendor 응답에서 이 패키지의 어휘만 꺼낸다. 모양이 어긋나면 값이 아니라 `null`이다. */
function readVendorContextUsage(response: unknown): ClaudeGatewayContextUsage | null {
  if (typeof response !== "object" || response === null) return null;
  const usage = response as {
    totalTokens?: unknown;
    maxTokens?: unknown;
    model?: unknown;
    isAutoCompactEnabled?: unknown;
    autoCompactThreshold?: unknown;
    categories?: unknown;
    memoryFiles?: unknown;
    mcpTools?: unknown;
  };
  if (typeof usage.totalTokens !== "number" || typeof usage.maxTokens !== "number") return null;
  const rows = Array.isArray(usage.categories) ? usage.categories : [];
  const memory = Array.isArray(usage.memoryFiles) ? usage.memoryFiles : [];
  const mcp = Array.isArray(usage.mcpTools) ? usage.mcpTools : [];
  return {
    total: usage.totalTokens,
    max: usage.maxTokens,
    model: typeof usage.model === "string" ? usage.model : "",
    compactAt: usage.isAutoCompactEnabled === true && typeof usage.autoCompactThreshold === "number"
      ? usage.autoCompactThreshold
      : null,
    categories: rows.flatMap((row: unknown) => {
      const entry = row as { name?: unknown; tokens?: unknown; isDeferred?: unknown };
      return typeof entry?.name === "string" && typeof entry.tokens === "number"
        ? [{ name: entry.name, tokens: entry.tokens, deferred: entry.isDeferred === true }]
        : [];
    }),
    memoryFiles: memory.flatMap((row: unknown) => {
      const entry = row as { path?: unknown; tokens?: unknown };
      return typeof entry?.path === "string" && typeof entry.tokens === "number"
        ? [{ path: entry.path, tokens: entry.tokens }]
        : [];
    }),
    mcpTools: mcp.flatMap((row: unknown) => {
      const entry = row as { name?: unknown; serverName?: unknown; tokens?: unknown };
      return typeof entry?.name === "string" && typeof entry.tokens === "number"
        ? [{ name: entry.name, server: typeof entry.serverName === "string" ? entry.serverName : "", tokens: entry.tokens }]
        : [];
    }),
  };
}

export function runVendorQuery(input: VendorQueryInput): ClaudeGatewayRun {
  const run = vendorQuery({
    prompt: input.prompt,
    options: input.options,
  } as never) as AsyncGenerator<unknown, void> & {
    return?: (value?: unknown) => Promise<unknown>;
    getContextUsage?: () => Promise<unknown>;
  };

  let closed = false;
  return {
    async getContextUsage(): Promise<ClaudeGatewayContextUsage | null> {
      // 닫힌 뒤의 호출은 물어볼 상대가 없다. transport 오류를 기다리느니 여기서 접는다.
      if (closed || typeof run.getContextUsage !== "function") return null;
      try {
        return readVendorContextUsage(await run.getContextUsage());
      } catch {
        // 턴이 끝나 가면 자식이 먼저 닫힌다 — 정상 경로의 실패다.
        return null;
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ClaudeGatewayMessage> {
      const iterator = run[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<ClaudeGatewayMessage>> {
          const result = await iterator.next();
          return result.done === true
            ? { done: true, value: undefined }
            : { done: false, value: result.value as ClaudeGatewayMessage };
        },
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      // AsyncGenerator.return()은 이미 끝난 generator에도 안전하다. 진행 중이던 턴은 여기서 끊긴다.
      // cleanup 예외는 결과·프로세스 종점을 바꾸지 않는다. 반환 Promise는 기다리지 않는다.
      try {
        const closing = run.return?.(undefined);
        if (closing !== undefined) void closing.catch(() => undefined);
      } catch {
        // return() 호출 자체의 동기 throw도 같은 cleanup 실패다.
      }
    },
  };
}

/**
 * 자식에게 밀어 넣을 사용자 메시지의 대기열.
 *
 * vendor는 `prompt`가 문자열이면 single-turn으로 보고 첫 `result`에 자식의 stdin을 닫지만,
 * AsyncIterable이면 **그 이터레이터가 끝날 때까지** 열어 둔다. 이 큐가 스스로 끝나지 않는 것이
 * 곧 "사용자가 아직 있다"는 신호이고, 백그라운드 작업이 턴을 넘어 사는 유일한 근거다.
 */
class VendorInputQueue implements AsyncIterable<unknown> {
  private readonly pending: unknown[] = [];
  private waiting: ((result: IteratorResult<unknown>) => void) | null = null;
  private closed = false;

  push(message: unknown): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ done: false, value: message });
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        if (this.pending.length > 0) return { done: false, value: this.pending.shift() };
        if (this.closed) return { done: true, value: undefined };
        // 대기자는 하나다 — vendor의 `streamInput`이 이 이터레이터를 직렬로 소비한다.
        return await new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * 사용자 메시지 하나. 모양은 vendor가 **문자열 프롬프트에 대해 스스로 만드는 것**을 그대로 옮긴
 * 것이다(0.3.212 확인): `session_id`는 빈 문자열이고 본문은 text 블록 하나다. 지어내지 않고
 * 베낀 이유는, 이 모양이 어긋나면 자식이 조용히 프롬프트를 잃기 때문이다.
 */
function vendorUserMessage(text: string): Record<string, unknown> {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

export function runVendorSession(input: VendorSessionInput): ClaudeGatewaySession {
  const queue = new VendorInputQueue();
  const run = vendorQuery({
    prompt: queue,
    options: input.options,
  } as never) as AsyncGenerator<unknown, void> & {
    close?: () => void;
    return?: (value?: unknown) => Promise<unknown>;
    getContextUsage?: () => Promise<unknown>;
    interrupt?: () => Promise<unknown>;
    stopTask?: (taskId: string) => Promise<void>;
    backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
  };

  let closed = false;
  return {
    send(text: string): void {
      if (closed) return;
      queue.push(vendorUserMessage(text));
    },
    async interrupt(): Promise<void> {
      if (closed || typeof run.interrupt !== "function") return;
      await run.interrupt();
    },
    async stopTask(taskId: string): Promise<void> {
      if (closed) return;
      if (typeof run.stopTask !== "function") {
        throw new TypeError("This Claude Agent SDK build has no stopTask control request.");
      }
      await run.stopTask(taskId);
    },
    async backgroundTasks(toolUseId?: string): Promise<boolean> {
      if (closed) return false;
      if (typeof run.backgroundTasks !== "function") {
        throw new TypeError("This Claude Agent SDK build has no background_tasks control request.");
      }
      return await run.backgroundTasks(toolUseId);
    },
    async getContextUsage(): Promise<ClaudeGatewayContextUsage | null> {
      if (closed || typeof run.getContextUsage !== "function") return null;
      try {
        return readVendorContextUsage(await run.getContextUsage());
      } catch {
        // 턴이 도는 동안 자식은 control 채널을 닫아 둔다 — 정상 경로의 실패다.
        return null;
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ClaudeGatewayMessage> {
      const iterator = run[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<ClaudeGatewayMessage>> {
          const result = await iterator.next();
          return result.done === true
            ? { done: true, value: undefined }
            : { done: false, value: result.value as ClaudeGatewayMessage };
        },
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      // 입력을 먼저 닫는다 — 자식이 정상 종료 신호를 먼저 보고, 그다음 프로세스가 접힌다.
      queue.close();
      try {
        if (typeof run.close === "function") run.close();
        else {
          const closing = run.return?.(undefined);
          if (closing !== undefined) void closing.catch(() => undefined);
        }
      } catch {
        // cleanup 실패는 결과·프로세스 종점을 바꾸지 않는다.
      }
    },
  };
}

export function defineVendorTool<TInput extends Record<string, unknown>>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  handler: (args: TInput, extra: unknown) => Promise<ClaudeGatewayToolResult>,
  extras?: ClaudeGatewayToolExtras,
): ClaudeGatewayTool {
  const definition = vendorTool(
    name,
    description,
    inputSchema as never,
    handler as never,
    extras as never,
  );
  return definition as unknown as ClaudeGatewayTool;
}

export function createVendorMcpServer(options: {
  readonly name: string;
  readonly version?: string;
  readonly tools?: readonly unknown[];
  readonly alwaysLoad?: boolean;
}): ClaudeGatewayMcpServer {
  const server = vendorCreateSdkMcpServer(options as never);
  return server as unknown as ClaudeGatewayMcpServer;
}

/** 자식이 남긴 세션 기록에서 사람이 읽을 제목만 꺼낸다. 없으면 null. */
export interface ClaudeSessionTitle {
  readonly customTitle: string | null;
  readonly summary: string | null;
  readonly firstPrompt: string | null;
}

export async function readVendorSessionTitle(
  sessionId: string,
  cwd: string,
): Promise<ClaudeSessionTitle | null> {
  const info = await vendorGetSessionInfo(sessionId, { dir: cwd });
  if (!info) return null;
  return {
    customTitle: info.customTitle ?? null,
    summary: info.summary ?? null,
    firstPrompt: info.firstPrompt ?? null,
  };
}
