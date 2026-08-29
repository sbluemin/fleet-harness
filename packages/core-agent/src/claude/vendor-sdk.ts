/**
 * 이 리포에서 `@anthropic-ai/claude-agent-sdk`를 부르는 유일한 신규 지점.
 *
 * `scripts/check-claude-agent-sdk-boundary.mjs`가 이 파일 외의 import와 manifest 선언을 매 PR에
 * 차단한다. 여기서 내보내는 모든 함수의 시그니처는 `./contracts.js`와 내장 타입으로만 이루어진다 —
 * vendor 타입이 형제 모듈의 `.d.ts`로 새면 소비자 해석 그래프가 다시 vendor를 요구하게 되고,
 * 그것이 이 패키지가 막으려는 바로 그 상태다.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import {
  createSdkMcpServer as vendorCreateSdkMcpServer,
  getSessionInfo as vendorGetSessionInfo,
  query as vendorQuery,
  tool as vendorTool,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeGatewayAgent,
  ClaudeGatewayCommand,
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

/**
 * 자식 CLI 바이너리를 담은 vendor 플랫폼 패키지의 이름 앞부분.
 *
 * 내보내지 않는다. `export`하면 이 리터럴이 `vendor-sdk.d.ts`에 상수 타입으로 실려, 형제 선언에
 * vendor 이름이 남지 않아야 한다는 이 패키지의 격리가 그 자리에서 깨진다.
 */
const VENDOR_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** musl 동적 로더의 절대 경로. vendor의 실패 메시지가 지목하는 바로 그 파일이다. */
const MUSL_LOADERS: Readonly<Record<string, string>> = {
  x64: "/lib/ld-musl-x86_64.so.1",
  arm64: "/lib/ld-musl-aarch64.so.1",
};

/**
 * musl 바이너리를 먼저 볼지. vendor의 `process.report.getReport()` 판정을 대신한다.
 *
 * vendor는 리포트의 `header.glibcVersionRuntime`이 비어 있는 것을 musl의 증거로 쓴다. 그 한
 * 필드를 얻으려고 힙·네이티브 스택·libuv 핸들·네트워크 인터페이스를 훑는 진단 리포트를 통째로
 * 만드는데, 정작 우리가 물어야 하는 것은 훨씬 좁다: **musl 바이너리가 이 호스트에서 뜨는가.**
 *
 * 그 답은 musl 동적 로더 하나의 존재로 결정된다 — vendor 자신의 실패 메시지도 같은 것을 지목한다
 * ("the musl dynamic loader (/lib/ld-musl-*) is missing"). musl 링크 바이너리는 로더가 있으면
 * 돌고 없으면 어떤 판정을 내려도 돌지 않는다. 그래서 이 검사는 현실적인 모든 호스트에서 vendor와
 * 같은 답을 내고(Alpine은 로더가 있어 musl, glibc 배포판은 없어 glibc), 둘이 어긋나는 드문
 * 경우(glibc 호스트에 musl 패키지가 함께 깔린 경우)에도 **실제로 뜨는** 바이너리를 고른다.
 *
 * 로더 이름은 arch의 기계 이름을 쓴다. 표에 없는 arch는 vendor가 musl 빌드를 내지 않으므로
 * 순서를 정할 필요 자체가 없다.
 */
function prefersMuslBinary(
  platform: string,
  arch: string,
  exists: (candidate: string) => boolean,
): boolean {
  if (platform !== "linux") return false;
  const loader = MUSL_LOADERS[arch];
  return loader !== undefined && exists(loader);
}

/** 경로 해석이 기대는 바깥 사실들. 테스트는 이 시드로 다른 플랫폼의 판정을 재현한다. */
export interface ClaudeExecutableProbe {
  readonly platform: string;
  readonly arch: string;
  /** musl 빌드를 먼저 볼지. vendor의 `preferMusl`과 같은 자리다. */
  readonly preferMusl: boolean;
  /** vendor 자신의 위치를 기준으로 도는 `require.resolve`. */
  readonly resolve: (specifier: string) => string;
  readonly exists: (candidate: string) => boolean;
}

/**
 * vendor가 고를 바이너리를 그대로 고른다.
 *
 * 후보 이름과 순서는 vendor의 해석기를 옮긴 것이다(0.3.212 확인). 이 리포는 배포 타깃 때문에
 * `supportedArchitectures`로 8개 플랫폼 패키지를 전부 설치하므로, 리눅스에서는 glibc·musl
 * 후보가 **둘 다 디스크에 있다**. 그래서 "설치된 것 하나를 고른다"로는 답이 정해지지 않고
 * 순서가 곧 판정이 된다 — `preferMusl`이 그 순서를 쥔다.
 */
export function resolveClaudeExecutable(probe: ClaudeExecutableProbe): string | null {
  const suffix = probe.platform === "win32" ? ".exe" : "";
  const linux = `${VENDOR_PACKAGE}-linux-${probe.arch}`;
  const packages = probe.platform === "android"
    ? [`${linux}-android`]
    : probe.platform === "linux"
      ? (probe.preferMusl ? [`${linux}-musl`, linux] : [linux, `${linux}-musl`])
      : [`${VENDOR_PACKAGE}-${probe.platform}-${probe.arch}`];

  for (const name of packages) {
    try {
      const candidate = probe.resolve(`${name}/claude${suffix}`);
      if (probe.exists(candidate)) return candidate;
    } catch {
      // 설치되지 않은 플랫폼 패키지는 resolve에서 걸린다. 다음 후보로 넘어갈 뿐 실패가 아니다.
    }
  }
  return null;
}

/**
 * 프로세스 수명 동안 유지되는 해석 결과.
 *
 * `undefined`는 "아직 안 풀었다", `null`은 "vendor에게 맡긴다"다. 두 상태를 한 값으로 합치면
 * 맡기기로 한 판정을 매 턴 다시 계산하게 되고, 그것이 이 파일이 없애려는 바로 그 반복이다.
 */
let resolvedExecutable: string | null | undefined;

function claudeExecutablePath(): string | null {
  if (resolvedExecutable !== undefined) return resolvedExecutable;
  resolvedExecutable = probeClaudeExecutable();
  return resolvedExecutable;
}

function probeClaudeExecutable(): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    // 플랫폼 패키지는 vendor의 optionalDependencies다. pnpm의 격리 레이아웃에서 그 패키지들은
    // vendor 자신의 위치에서만 풀리므로, require 기준점을 이 패키지가 아니라 vendor 진입점으로 잡는다.
    const requireFromVendor = createRequire(requireFromHere.resolve(VENDOR_PACKAGE));
    const exists = (candidate: string): boolean => existsSync(candidate);
    return resolveClaudeExecutable({
      platform: process.platform,
      arch: process.arch,
      preferMusl: prefersMuslBinary(process.platform, process.arch, exists),
      resolve: (specifier) => requireFromVendor.resolve(specifier),
      exists,
    });
  } catch {
    // 해석 실패는 기능이 아니라 최적화만 잃는다 — vendor가 오늘처럼 스스로 푼다.
    return null;
  }
}

/**
 * vendor `query()` 옵션에 자식 바이너리 경로를 실어 준다.
 *
 * 이 한 줄이 이 모듈이 막으려는 정지의 전부다. vendor는 `pathToClaudeCodeExecutable`이 비어
 * 있을 때만 스스로 경로를 푸는데(0.3.212: `if(!pathToClaudeCodeExecutable){…}`), 그 해석의
 * 기본값이 리눅스에서 musl/glibc를 가르려고 `process.report.getReport()`를 부른다. 그 호출은
 * 힙·네이티브 스택·libuv 핸들·네트워크 인터페이스를 훑는 진단 리포트를 **동기로** 만들고 vendor는
 * 결과를 캐시하지 않으므로, 턴마다 자식을 새로 여는 채팅 경로에서는 그 정지가 매번 되풀이된다.
 * 같은 프로세스가 HTTP도 서빙하므로 멈추는 것은 채팅만이 아니라 Console 전체다.
 *
 * 값을 실으면 vendor는 그 분기에 아예 들어가지 않는다. 못 풀었으면 오늘과 같은 옵션 그대로 간다.
 */
function withResolvedExecutable(
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const executable = claudeExecutablePath();
  return executable === null ? { ...options } : { ...options, pathToClaudeCodeExecutable: executable };
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
    options: withResolvedExecutable(input.options),
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

/**
 * 벤더의 `SlashCommand[]`를 계약 레코드로 옮긴다. `name`이 없는 항목은 부를 수 없으므로
 * 통째로 버린다 — 이름 없는 행을 목록에 세우면 고를 수는 있는데 보낼 수는 없는 항목이 된다.
 */
function readVendorCommands(response: unknown): readonly ClaudeGatewayCommand[] | null {
  if (!Array.isArray(response)) return null;
  return response.flatMap((row: unknown) => {
    const entry = row as { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown };
    if (typeof entry?.name !== "string" || entry.name.length === 0) return [];
    return [{
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      argumentHint: typeof entry.argumentHint === "string" ? entry.argumentHint : "",
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.filter((alias: unknown): alias is string => typeof alias === "string")
        : [],
    }];
  });
}

/** 벤더의 `AgentInfo[]`를 계약 레코드로 옮긴다. 이름 없는 항목을 버리는 이유는 위와 같다. */
function readVendorAgents(response: unknown): readonly ClaudeGatewayAgent[] | null {
  if (!Array.isArray(response)) return null;
  return response.flatMap((row: unknown) => {
    const entry = row as { name?: unknown; description?: unknown; model?: unknown };
    if (typeof entry?.name !== "string" || entry.name.length === 0) return [];
    return [{
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      model: typeof entry.model === "string" && entry.model.length > 0 ? entry.model : null,
    }];
  });
}

export function runVendorSession(input: VendorSessionInput): ClaudeGatewaySession {
  const queue = new VendorInputQueue();
  const run = vendorQuery({
    prompt: queue,
    options: withResolvedExecutable(input.options),
  } as never) as AsyncGenerator<unknown, void> & {
    close?: () => void;
    return?: (value?: unknown) => Promise<unknown>;
    getContextUsage?: () => Promise<unknown>;
    interrupt?: () => Promise<unknown>;
    stopTask?: (taskId: string) => Promise<void>;
    backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
    supportedCommands?: () => Promise<unknown>;
    supportedAgents?: () => Promise<unknown>;
    reloadSkills?: () => Promise<unknown>;
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
    async supportedCommands(): Promise<readonly ClaudeGatewayCommand[] | null> {
      if (closed || typeof run.supportedCommands !== "function") return null;
      try {
        return readVendorCommands(await run.supportedCommands());
      } catch {
        // control 채널이 닫혀 있을 뿐이다 — 카탈로그가 비었다는 뜻이 아니므로 null이다.
        return null;
      }
    },
    async supportedAgents(): Promise<readonly ClaudeGatewayAgent[] | null> {
      if (closed || typeof run.supportedAgents !== "function") return null;
      try {
        return readVendorAgents(await run.supportedAgents());
      } catch {
        return null;
      }
    },
    async reloadSkills(): Promise<readonly ClaudeGatewayCommand[] | null> {
      if (closed || typeof run.reloadSkills !== "function") return null;
      try {
        const response = await run.reloadSkills();
        // 응답은 `{ skills: SlashCommand[] }`다 — 명령 목록과 같은 레코드 모양이라 같은 파서를 쓴다.
        return readVendorCommands((response as { skills?: unknown } | null)?.skills);
      } catch {
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
