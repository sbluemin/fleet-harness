/**
 * E2E 테스트 공용 헬퍼 함수
 */

import { execSync, spawn, spawnSync } from 'child_process';
import * as http from 'node:http';
import { resolve } from 'path';
import { UnifiedAgent, type IUnifiedAgentClient } from '../../src/index.js';
import type { CliType } from '../../src/types/config.js';

/** CLI JSON 출력 결과 타입 */
export interface CliJsonResult {
  response: string;
  cli: string;
  sessionId: string;
}

/** 모델 실행 가능 여부 probe 결과 */
export interface ModelAvailabilityProbe {
  available: boolean;
  reason?: string;
}

/** CLI 바이너리 경로 */
export const CLI_PATH = resolve(import.meta.dirname, '../../dist/cli.js');

/** Node.js 실행 경로 */
export const NODE = process.execPath;

/** 기본 프롬프트 (도구 사용 없이 즉시 답할 수 있는 산술 — 응답에 "2" 포함 검증용) */
export const SIMPLE_PROMPT = '코드 실행이나 도구 사용 없이 바로 답해줘. 1+1의 결과를 숫자만 답해. 다른 설명은 하지 마.';

/** 세션 재개 테스트용 1차 프롬프트 (숫자 기억 요청) */
export const SESSION_REMEMBER_PROMPT = '코드 실행이나 도구 사용 없이 바로 답해줘. 지금부터 내가 말하는 숫자를 기억해. 숫자는 42야.';

/** 세션 재개 테스트용 2차 프롬프트 (기억한 숫자 확인) */
export const SESSION_RECALL_PROMPT = '코드 실행이나 도구 사용 없이 바로 답해줘. 내가 아까 말한 숫자가 뭐였어?';

/** CLI 설치 여부 확인 (which 기반) */
export function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Promise에 타임아웃을 적용하는 래퍼 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[${label}] ${ms}ms 타임아웃 초과`)), ms),
    ),
  ]);
}

/** SDK로 연결 후 sessionId를 반환하는 헬퍼 */
export async function connectClient(
  cli: CliType,
  opts?: { model?: string; sessionId?: string; strictMcp?: boolean; effort?: string },
): Promise<{ client: IUnifiedAgentClient; sessionId: string | null }> {
  const client = await UnifiedAgent.build({ cli, sessionId: opts?.sessionId });

  // error 리스너 등록 (미등록 시 Unhandled error crash 방지)
  client.on('error', () => {});

  const result = await withTimeout(
    client.connect({
      cwd: process.cwd(),
      cli,
      autoApprove: true,
      model: opts?.model,
      effort: opts?.effort,
      sessionId: opts?.sessionId,
      strictMcp: opts?.strictMcp,
      clientInfo: { name: 'E2E-Test', version: '1.0.0' },
    }),
    120_000,
    `${cli} 연결`,
  );

  const sessionId = result.session?.sessionId ?? client.getConnectionInfo().sessionId ?? null;
  return { client, sessionId };
}

/** SDK 클라이언트로 프롬프트를 전송하고 messageChunk를 수집하여 전체 응답을 반환 */
export async function sendAndCollect(
  client: IUnifiedAgentClient,
  prompt: string,
): Promise<{ response: string; chunks: string[] }> {
  const chunks: string[] = [];

  client.on('messageChunk', (text: string) => {
    chunks.push(text);
  });

  await withTimeout(
    client.sendMessage(prompt),
    120_000,
    '프롬프트 응답',
  );

  // 스트리밍 응답 대기 (최대 60초)
  const start = Date.now();
  while (chunks.length === 0 && Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const response = chunks.join('');
  return { response, chunks };
}

/** SDK 클라이언트로 프롬프트를 전송하고 thought/message 스트림과 지연 시간을 함께 측정 */
export async function sendAndMeasure(
  client: IUnifiedAgentClient,
  prompt: string,
): Promise<{
  response: string;
  chunks: string[];
  thoughts: string[];
  thoughtText: string;
  thoughtLength: number;
  thoughtCount: number;
  latencyMs: number;
}> {
  const chunks: string[] = [];
  const thoughts: string[] = [];

  client.on('messageChunk', (text: string) => {
    chunks.push(text);
  });
  client.on('thoughtChunk', (text: string) => {
    thoughts.push(text);
  });

  const startedAt = Date.now();
  await withTimeout(
    client.sendMessage(prompt),
    180_000,
    '프롬프트 응답',
  );
  const latencyMs = Date.now() - startedAt;
  await waitForChunkIdle(chunks, thoughts);

  const thoughtText = thoughts.join('');
  const response = chunks.join('');

  return {
    response,
    chunks,
    thoughts,
    thoughtText,
    thoughtLength: thoughtText.length,
    thoughtCount: thoughts.length,
    latencyMs,
  };
}

async function waitForChunkIdle(chunks: string[], thoughts: string[]): Promise<void> {
  const startedAt = Date.now();
  let lastSignature = `${chunks.length}:${thoughts.length}`;
  let idleSince = Date.now();

  while (Date.now() - startedAt < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const nextSignature = `${chunks.length}:${thoughts.length}`;
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature;
      idleSince = Date.now();
      continue;
    }

    if (Date.now() - idleSince >= 400) {
      return;
    }
  }
}

/** CLI 바이너리(dist/cli.js)를 비동기로 실행하는 헬퍼 */
export function runCli(
  args: string[],
  opts?: { input?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI_PATH, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts?.timeout ?? 180_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    if (opts?.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 특정 CLI/모델 조합이 현재 환경에서 실제로 실행 가능한지 동기 probe합니다.
 *
 * 알려진 환경 이슈(레이트 리밋, 구독/모델 미지원)인 경우만 unavailable로 처리하고,
 * 그 외 예기치 않은 실패는 테스트가 실제로 드러내도록 available=true로 둡니다.
 */
export function probeCliModelAvailability(
  cli: CliType,
  model: string,
): ModelAvailabilityProbe {
  const result = spawnSync(
    NODE,
    [CLI_PATH, '--json', '-c', cli, '-m', model, SIMPLE_PROMPT],
    {
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 120_000,
    },
  );

  if (result.status === 0) {
    return { available: true };
  }

  const combined = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n');

  if (isKnownModelUnavailable(combined)) {
    return { available: false, reason: combined.trim() };
  }

  // 알려진 가용성 문제가 아니면 실제 테스트에서 드러나도록 실행 가능으로 간주합니다.
  return { available: true };
}

// ─── 테스트용 MCP 서버 ────────────────────────────────────

export interface TestMcpServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * 테스트용 MCP HTTP 서버를 시작합니다.
 * `add_numbers` 도구를 제공하여 MCP 호출 검증에 사용합니다.
 */
export async function startTestMcpServer(): Promise<TestMcpServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const response = handleMcpRequest(body);
      if (!response) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function handleMcpRequest(body: { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> }) {
  const { id, method, params } = body;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'add_numbers',
              description: '두 숫자를 더합니다.',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number', description: '첫 번째 숫자' },
                  b: { type: 'number', description: '두 번째 숫자' },
                },
                required: ['a', 'b'],
              },
            },
          ],
        },
      };

    case 'tools/call': {
      const args = (params?.arguments ?? {}) as { a?: number; b?: number };
      const a = args.a ?? 0;
      const b = args.b ?? 0;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `${a + b}` }],
        },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function isKnownModelUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    'rate limit reached',
    'rate limit',
    'quota',
    'not available',
    'does not have access',
    'subscription',
    'invalid value for config option model',
    'unsupported model',
  ].some((token) => normalized.includes(token));
}
