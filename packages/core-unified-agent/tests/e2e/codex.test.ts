/**
 * E2E: Codex 공식 ACP bridge 테스트
 * Codex CLI를 공식 codex-acp bridge로 연결하여 프롬프트, 모델, effort, 세션 재개를 검증합니다.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  isCliInstalled,
  connectClient,
  sendAndCollect,
  runCli,
  startTestMcpServer,
  SIMPLE_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SESSION_RECALL_PROMPT,
} from './helpers.js';
import { UnifiedAgent, type IUnifiedAgentClient } from '../../src/index.js';
import { CodexAppServerConnection } from '../../src/connection/CodexAppServerConnection.js';
import type { TestMcpServer, CliJsonResult } from './helpers.js';

class MockCodexStream extends EventEmitter {
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

class MockCodexChildProcess extends EventEmitter {
  stdout = new MockCodexStream();
  stderr = new MockCodexStream();
  stdin = new MockCodexStream();
  pid = 2468;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }
}

class MockCodexAppServerConnection extends CodexAppServerConnection {
  constructor(private readonly mockChild: MockCodexChildProcess) {
    super({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd: process.cwd(),
    });
  }

  protected spawnRawProcess(): ChildProcess {
    this.setState('connecting');
    this.child = this.mockChild as unknown as ChildProcess;
    this.childExitPromise = Promise.resolve();
    this.mockChild.stderr.on('data', (data: Buffer | string) => {
      this.consumeStderrChunk(data.toString());
    });
    this.mockChild.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.flushStderrBuffer();
      this.setState('closed');
      this.emit('exit', code, signal);
    });
    this.mockChild.on('error', (error: Error) => {
      this.flushStderrBuffer();
      this.setState('error');
      this.emit('error', error);
    });
    return this.mockChild as unknown as ChildProcess;
  }
}

const CLI = 'codex';
const installed = isCliInstalled(CLI);
const CODEX_MODEL_MATRIX = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
const CODEX_EFFORT_MATRIX = [
  ['gpt-5.6-sol', 'low'],
  ['gpt-5.6-sol', 'medium'],
  ['gpt-5.6-sol', 'high'],
  ['gpt-5.6-sol', 'xhigh'],
  ['gpt-5.6-sol', 'max'],
  ['gpt-5.6-sol', 'ultra'],
  ['gpt-5.6-terra', 'low'],
  ['gpt-5.6-terra', 'medium'],
  ['gpt-5.6-terra', 'high'],
  ['gpt-5.6-terra', 'xhigh'],
  ['gpt-5.6-terra', 'max'],
  ['gpt-5.6-terra', 'ultra'],
  ['gpt-5.6-luna', 'low'],
  ['gpt-5.6-luna', 'medium'],
  ['gpt-5.6-luna', 'high'],
  ['gpt-5.6-luna', 'xhigh'],
  ['gpt-5.6-luna', 'max'],
] as const;

describe.skipIf(!installed)('E2E: Codex official ACP bridge', () => {
  let client: IUnifiedAgentClient | null = null;
  let originalCodexUseAcp: string | undefined;

  beforeEach(() => {
    originalCodexUseAcp = process.env.CODEX_USE_ACP;
    process.env.CODEX_USE_ACP = 'true';
  });

  afterEach(async () => {
    try {
      if (client) {
        try {
          await client.disconnect();
        } finally {
          client = null;
        }
      }
    } finally {
      if (originalCodexUseAcp === undefined) {
        delete process.env.CODEX_USE_ACP;
      } else {
        process.env.CODEX_USE_ACP = originalCodexUseAcp;
      }
    }
  });

  // ═══════════════════════════════════════════════
  // 기본 연결 & 프롬프트
  // ═══════════════════════════════════════════════

  describe('기본 연결 & 프롬프트', () => {
    it('SDK: 공식 ACP bridge 연결 → 프롬프트 → 응답 검증', async () => {
      const { client: c, sessionId } = await connectClient('codex');
      client = c;

      expect(sessionId).toBeTruthy();
      expect(client.getConnectionInfo().protocol).toBe('acp');

      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');
    }, 180_000);

    it('CLI: pretty 모드 프롬프트', async () => {
      const { stdout, stderr, exitCode } = await runCli(
        ['-c', 'codex', SIMPLE_PROMPT],
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('2');
      expect(stderr).toContain('unified-agent');
    }, 180_000);

    it('CLI: JSON 모드 프롬프트', async () => {
      const { stdout, exitCode } = await runCli(
        ['--json', '-c', 'codex', SIMPLE_PROMPT],
      );

      expect(exitCode).toBe(0);
      const result: CliJsonResult = JSON.parse(stdout.trim());
      expect(result.response).toContain('2');
      expect(result.cli).toBe('codex');
      expect(result.sessionId.length).toBeGreaterThan(0);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // Disconnect 후 프로세스 종료
  // ═══════════════════════════════════════════════

  describe('Disconnect 후 프로세스 종료', () => {
    it('SDK: 연결 → 프롬프트 → disconnect → 프로세스 종료 및 상태 초기화 검증', async () => {
      // 최소 모델/effort로 연결
      const { client: c, sessionId } = await connectClient('codex', { model: 'gpt-5.6-sol' });
      client = c;
      expect(sessionId).toBeTruthy();

      // 프롬프트 전송 → 정상 응답 확인
      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');

      // disconnect → Codex ACP bridge 프로세스 종료
      await client.disconnect();

      // 연결 상태 초기화 확인
      const info = client.getConnectionInfo();
      expect(info.state).toBe('disconnected');
      expect(info.cli).toBeNull();
      expect(info.sessionId).toBeNull();

      // 재전송 시 에러 발생 확인
      await expect(client.sendMessage(SIMPLE_PROMPT)).rejects.toThrow();

      client = null;
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // AppServer exit 분류 회귀
  // ═══════════════════════════════════════════════

  describe('AppServer exit 분류 회귀', () => {
    it('정상 exit(0)은 turn 완료 전 false crash로 reject하지 않는다', async () => {
      const { child, connection } = await establishMockCodexSession();

      const sendPromise = connection.sendMessage([mockTextInput('hi')]);
      await flushMicrotask();
      child.stdout.emit('data', `${jsonRpcResult(3, { turn: { id: 'turn-1' } })}\n`);
      child.exitCode = 0;
      child.emit('exit', 0, null);

      await expect(sendPromise).resolves.toBeUndefined();
    });

    it('intentional disconnect는 active turn을 false crash로 reject하지 않는다', async () => {
      const { child, connection } = await establishMockCodexSession();

      const sendPromise = connection.sendMessage([mockTextInput('hi')]);
      await flushMicrotask();
      child.stdout.emit('data', `${jsonRpcResult(3, { turn: { id: 'turn-1' } })}\n`);

      await expect(connection.disconnect()).resolves.toBeUndefined();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it('비정상 signal kill은 진단 정보를 포함해 reject한다', async () => {
      const { child, connection } = await establishMockCodexSession();

      const sendPromise = connection.sendMessage([mockTextInput('hi')]);
      await flushMicrotask();
      child.stdout.emit(
        'data',
        `${jsonRpcNotification('turn/started', {
          threadId: 'thread-1',
          turn: { id: 'turn-1' },
        })}\n`,
      );
      for (let index = 0; index < 25; index += 1) {
        child.stderr.emit('data', `stderr-${index}\n`);
      }
      child.emit('exit', null, 'SIGTERM');

      await expect(sendPromise).rejects.toThrow(/code=null, signal=SIGTERM/);
      await expect(sendPromise).rejects.toThrow(/lastNotification=turn\/started/);
      await expect(sendPromise).rejects.toThrow(/pendingRequests=3/);
      await expect(sendPromise).rejects.toThrow(/stderr-24/);
      await expect(sendPromise).rejects.not.toThrow(/stderr-0/);
    });
  });

  // ═══════════════════════════════════════════════
  // 도구 호출 자동 승인
  // ═══════════════════════════════════════════════

  describe('도구 호출 자동 승인', () => {
    it('SDK: 도구 호출이 필요한 프롬프트 → 자동 승인 → 응답 수신 (hang 없음)', async () => {
      const { client: c } = await connectClient('codex');
      client = c;

      const toolCalls: string[] = [];
      client.on('toolCall', (title: string) => {
        toolCalls.push(title);
      });

      const { response } = await sendAndCollect(
        client,
        '현재 디렉토리에서 ls 명령을 실행하고 결과를 알려줘.',
      );

      expect(response.length).toBeGreaterThan(0);
      expect(toolCalls.length).toBeGreaterThan(0);
    }, 180_000);

    it('CLI: 도구 호출이 필요한 프롬프트 → JSON 모드 → 응답 수신', async () => {
      const { stdout, exitCode } = await runCli(
        ['--json', '-c', 'codex', '현재 디렉토리에서 ls 명령을 실행하고 파일 목록을 알려줘.'],
      );

      expect(exitCode).toBe(0);
      const result: CliJsonResult = JSON.parse(stdout.trim());
      expect(result.response.length).toBeGreaterThan(0);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // MCP 서버 연동
  // ═══════════════════════════════════════════════

  describe('MCP 서버 연동', () => {
    let mcpServer: TestMcpServer | null = null;

    afterEach(async () => {
      if (mcpServer) {
        await mcpServer.close();
        mcpServer = null;
      }
    });

    it('SDK: MCP 도구(add_numbers) 호출 → 결과 반영된 응답 수신', async () => {
      mcpServer = await startTestMcpServer();

      const c = await UnifiedAgent.build({ cli: 'codex' });
      client = c;
      client.on('error', () => {});

      await client.connect({
        cwd: process.cwd(),
        cli: 'codex',
        autoApprove: true,
        clientInfo: { name: 'E2E-MCP-Test', version: '1.0.0' },
        mcpServers: [{
          type: 'http',
          name: 'test-math',
          url: mcpServer.url,
        }],
      });

      const toolCalls: string[] = [];
      client.on('toolCall', (title: string) => {
        toolCalls.push(title);
      });

      const chunks: string[] = [];
      client.on('messageChunk', (text: string) => {
        chunks.push(text);
      });

      await client.sendMessage(
        'add_numbers 도구를 사용해서 17과 25를 더해줘. 도구 결과를 그대로 말해줘.',
      );

      const response = chunks.join('');
      expect(response).toContain('42');
      expect(toolCalls).toContain('mcp.test-math.add_numbers');
      expect(response).not.toMatch(/도구.*(없|못 찾|찾을 수)|tool.*not.*found|lazy[- ]?load/i);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // 모델별 프롬프트
  // ═══════════════════════════════════════════════

  describe('모델별 프롬프트', () => {
    it.each(CODEX_MODEL_MATRIX)(
      'CLI: 모델 %s → 프롬프트 → 응답 검증',
      async (model) => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'codex', '-m', model, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('codex');
      },
      180_000,
    );
  });

  // ═══════════════════════════════════════════════
  // Reasoning effort
  // ═══════════════════════════════════════════════

  describe('Reasoning effort', () => {
    it.each(CODEX_EFFORT_MATRIX)(
      'CLI: 모델 %s effort %s → 프롬프트 → 응답 검증',
      async (model, effort) => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'codex', '-m', model, '-e', effort, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('codex');
      },
      180_000,
    );
  });

  // ═══════════════════════════════════════════════
  // thread 재개
  // ═══════════════════════════════════════════════

  describe('세션 재개', () => {
    it('CLI: 1차 프롬프트 → threadId → 2차 세션 재개 → 컨텍스트 유지', async () => {
      // 1차: 숫자 기억 요청
      const first = await runCli(
        ['--json', '-c', 'codex', SESSION_REMEMBER_PROMPT],
      );
      expect(first.exitCode).toBe(0);

      const firstResult: CliJsonResult = JSON.parse(first.stdout.trim());
      expect(firstResult.sessionId.length).toBeGreaterThan(0);

      // 2차: 세션 재개하여 기억한 숫자 확인
      const second = await runCli(
        ['--json', '-c', 'codex', '-s', firstResult.sessionId, SESSION_RECALL_PROMPT],
        { timeout: 360_000 },
      );
      expect(second.exitCode).toBe(0);

      const secondResult: CliJsonResult = JSON.parse(second.stdout.trim());
      expect(secondResult.response).toContain('42');
      expect(secondResult.sessionId).toBe(firstResult.sessionId);
    }, 360_000);

    it('SDK: 1차 연결 → 프롬프트 → disconnect → 2차 세션 복귀(loadSession) → 컨텍스트 유지', async () => {
      // 1차: SDK 연결 후 숫자 기억 요청
      const { client: c1, sessionId: firstSessionId } = await connectClient('codex');
      client = c1;

      expect(firstSessionId).toBeTruthy();

      const { response: firstResponse } = await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
      expect(firstResponse.length).toBeGreaterThan(0);

      await client.disconnect();
      client = null;

      // 2차: 동일 sessionId로 loadSession 경로를 거쳐 컨텍스트 확인
      const { client: c2, sessionId: secondSessionId } = await connectClient('codex', {
        sessionId: firstSessionId ?? undefined,
      });
      client = c2;

      const { response: secondResponse } = await sendAndCollect(client, SESSION_RECALL_PROMPT);
      expect(secondResponse).toContain('42');
      expect(secondSessionId).toBe(firstSessionId);
    }, 360_000);

    it('SDK: resetSession()이 새 threadId를 발급한다', async () => {
      const { client: c, sessionId } = await connectClient('codex');
      client = c;

      expect(sessionId).toBeTruthy();
      const firstThreadId = sessionId;
      const resetResult = await client.resetSession();
      const secondThreadId = client.getConnectionInfo().sessionId;

      expect(resetResult.protocol).toBe('acp');
      expect(secondThreadId).toBeTruthy();
      expect(secondThreadId).not.toBe(firstThreadId);
    }, 180_000);

    it('SDK: 신규 세션 첫 프롬프트부터 system prompt가 적용된다', async () => {
      const c = await UnifiedAgent.build({ cli: 'codex' });
      client = c;
      client.on('error', () => {});

      await client.connect({
        cwd: process.cwd(),
        cli: 'codex',
        autoApprove: true,
        systemPrompt: '사용자가 FRESH_SENTINEL을 물으면 FRESH-PROMPT-OK만 정확히 답하세요.',
        clientInfo: { name: 'E2E-SystemPrompt-Fresh-Test', version: '1.0.0' },
      });

      const { response } = await sendAndCollect(
        client,
        'FRESH_SENTINEL',
      );

      expect(response.trim()).toBe('FRESH-PROMPT-OK');
    }, 180_000);

    it('SDK: resetSession() 후에도 system prompt가 유지된다', async () => {
      const c = await UnifiedAgent.build({ cli: 'codex' });
      client = c;
      client.on('error', () => {});

      await client.connect({
        cwd: process.cwd(),
        cli: 'codex',
        autoApprove: true,
        systemPrompt: '사용자가 RESET_SENTINEL을 물으면 RESET-PROMPT-OK만 정확히 답하세요.',
        clientInfo: { name: 'E2E-SystemPrompt-Reset-Test', version: '1.0.0' },
      });

      await client.resetSession();
      const { response } = await sendAndCollect(
        client,
        'RESET_SENTINEL',
      );

      expect(response.trim()).toBe('RESET-PROMPT-OK');
    }, 180_000);
  });
});

async function establishMockCodexSession(): Promise<{
  child: MockCodexChildProcess;
  connection: MockCodexAppServerConnection;
}> {
  const child = new MockCodexChildProcess();
  const connection = new MockCodexAppServerConnection(child);
  const connectPromise = connection.connect();

  child.stdout.emit(
    'data',
    `${jsonRpcResult(1, {
      userAgent: 'codex/test',
      codexHome: '/tmp/codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    })}\n`,
  );
  await flushMicrotask();
  child.stdout.emit('data', `${jsonRpcResult(2, { thread: { id: 'thread-1' } })}\n`);
  await connectPromise;

  return { child, connection };
}

function mockTextInput(text: string): {
  type: 'text';
  text: string;
  text_elements: unknown[];
} {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function jsonRpcNotification(method: string, params: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  });
}

async function flushMicrotask(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
