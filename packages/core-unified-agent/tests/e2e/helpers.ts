/**
 * E2E 테스트 공용 헬퍼 함수
 */

import { execSync } from 'child_process';
import * as http from 'node:http';
import { UnifiedAgent, type IUnifiedAgentClient } from '../../src/index.js';
import type { CliType } from '../../src/config/CliConfigs.js';

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
