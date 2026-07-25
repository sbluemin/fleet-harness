/**
 * E2E: Codex App Server SDK 테스트
 */

import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAppServerConnection } from '../../src/connection/CodexAppServerConnection.js';
import { UnifiedAgent, type IUnifiedAgentClient } from '../../src/index.js';
import type { TestMcpServer } from './helpers.js';
import {
  connectClient,
  isCliInstalled,
  sendAndCollect,
  SESSION_RECALL_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SIMPLE_PROMPT,
  startTestMcpServer,
} from './helpers.js';

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

const installed = isCliInstalled('codex');

describe.skipIf(!installed)('E2E: Codex App Server SDK', () => {
  let client: IUnifiedAgentClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });

  it('App Server 연결 → 프롬프트 → 응답을 검증한다', async () => {
    const connected = await connectClient('codex');
    client = connected.client;

    expect(connected.sessionId).toBeTruthy();
    expect(client.getConnectionInfo().protocol).toBe('codex-app-server');
    const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
    expect(response).toContain('2');
  }, 180_000);

  it('disconnect 후 상태와 프로세스를 정리한다', async () => {
    const connected = await connectClient('codex', { model: 'gpt-5.6-sol' });
    client = connected.client;
    await sendAndCollect(client, SIMPLE_PROMPT);
    await client.disconnect();

    expect(client.getConnectionInfo()).toMatchObject({
      cli: null,
      sessionId: null,
      state: 'disconnected',
    });
    await expect(client.sendMessage(SIMPLE_PROMPT)).rejects.toThrow();
    client = null;
  }, 180_000);

  describe('App Server exit 분류 회귀', () => {
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
      child.stdout.emit('data', `${jsonRpcNotification('turn/started', {
        threadId: 'thread-1',
        turn: { id: 'turn-1' },
      })}\n`);
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

  it('도구 호출을 자동 승인한다', async () => {
    const connected = await connectClient('codex');
    client = connected.client;
    const toolCalls: string[] = [];
    client.on('toolCall', (title: string) => toolCalls.push(title));

    const { response } = await sendAndCollect(
      client,
      '현재 디렉토리에서 ls 명령을 실행하고 결과를 알려줘.',
    );
    expect(response.length).toBeGreaterThan(0);
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 180_000);

  describe('MCP 서버 연동', () => {
    let mcpServer: TestMcpServer | null = null;

    afterEach(async () => {
      if (mcpServer) {
        await mcpServer.close();
        mcpServer = null;
      }
    });

    it('MCP 도구 결과를 응답에 반영한다', async () => {
      mcpServer = await startTestMcpServer();
      client = await UnifiedAgent.build({ cli: 'codex' });
      client.on('error', () => {});
      await client.connect({
        cwd: process.cwd(),
        cli: 'codex',
        autoApprove: true,
        clientInfo: { name: 'E2E-MCP-Test', version: '1.0.0' },
        mcpServers: [{ type: 'http', name: 'test-math', url: mcpServer.url }],
      });

      const toolCalls: string[] = [];
      const chunks: string[] = [];
      client.on('toolCall', (title: string) => toolCalls.push(title));
      client.on('messageChunk', (text: string) => chunks.push(text));
      await client.sendMessage(
        'add_numbers 도구를 사용해서 17과 25를 더해줘. 도구 결과를 그대로 말해줘.',
      );

      expect(chunks.join('')).toContain('42');
      expect(toolCalls).toContain('mcp.test-math.add_numbers');
    }, 180_000);
  });

  it('기존 thread를 SDK로 재개한다', async () => {
    const first = await connectClient('codex');
    client = first.client;
    await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
    await client.disconnect();
    client = null;

    const second = await connectClient('codex', {
      sessionId: first.sessionId ?? undefined,
    });
    client = second.client;
    const recalled = await sendAndCollect(client, SESSION_RECALL_PROMPT);
    expect(recalled.response).toContain('42');
    expect(second.sessionId).toBe(first.sessionId);
  }, 360_000);

  it('resetSession()이 새 threadId를 발급한다', async () => {
    const connected = await connectClient('codex');
    client = connected.client;
    const resetResult = await client.resetSession();

    expect(resetResult.protocol).toBe('codex-app-server');
    expect(client.getConnectionInfo().sessionId).toBeTruthy();
    expect(client.getConnectionInfo().sessionId).not.toBe(connected.sessionId);
  }, 180_000);

  it.each([
    ['FRESH_SENTINEL', false],
    ['RESET_SENTINEL', true],
  ])('system prompt를 첫 프롬프트에 적용한다: %s', async (sentinel, reset) => {
    client = await UnifiedAgent.build({ cli: 'codex' });
    client.on('error', () => {});
    await client.connect({
      cwd: process.cwd(),
      cli: 'codex',
      autoApprove: true,
      systemPrompt: `사용자가 ${sentinel}을 물으면 ${sentinel}-PROMPT-OK만 정확히 답하세요.`,
      clientInfo: { name: 'E2E-SystemPrompt-Test', version: '1.0.0' },
    });
    if (reset) await client.resetSession();

    const { response } = await sendAndCollect(client, sentinel);
    expect(response.trim()).toBe(`${sentinel}-PROMPT-OK`);
  }, 180_000);
});

async function establishMockCodexSession(): Promise<{
  child: MockCodexChildProcess;
  connection: MockCodexAppServerConnection;
}> {
  const child = new MockCodexChildProcess();
  const connection = new MockCodexAppServerConnection(child);
  const connectPromise = connection.connect();
  child.stdout.emit('data', `${jsonRpcResult(1, {
    userAgent: 'codex/test',
    codexHome: '/tmp/codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  })}\n`);
  await flushMicrotask();
  child.stdout.emit('data', `${jsonRpcResult(2, { thread: { id: 'thread-1' } })}\n`);
  await connectPromise;
  return { child, connection };
}

function mockTextInput(text: string) {
  return { type: 'text' as const, text, text_elements: [] };
}

function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

async function flushMicrotask(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
