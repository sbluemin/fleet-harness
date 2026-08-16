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
  ClaudeGatewayTool,
  ClaudeGatewayToolExtras,
  ClaudeGatewayToolResult,
} from "./contracts.js";

/** 이미 조립이 끝난 vendor `query()` 인자. 조립 책임은 `./sdk.ts`에 있다. */
export interface VendorQueryInput {
  readonly prompt: string;
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
