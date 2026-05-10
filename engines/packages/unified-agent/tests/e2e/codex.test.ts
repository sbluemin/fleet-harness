/**
 * E2E: Codex native app-server 테스트
 * Codex CLI를 native app-server 프로토콜로 연결하여 프롬프트, 모델, effort, 세션 재개를 검증합니다.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
import type { TestMcpServer, CliJsonResult } from './helpers.js';

const CLI = 'codex';
const installed = isCliInstalled(CLI);

describe.skipIf(!installed)('E2E: Codex native app-server', () => {
  let client: IUnifiedAgentClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });

  // ═══════════════════════════════════════════════
  // 기본 연결 & 프롬프트
  // ═══════════════════════════════════════════════

  describe('기본 연결 & 프롬프트', () => {
    it('SDK: native app-server 연결 → 프롬프트 → 응답 검증', async () => {
      const { client: c, sessionId } = await connectClient('codex');
      client = c;

      expect(sessionId).toBeTruthy();
      expect(client.getConnectionInfo().protocol).toBe('codex-app-server');

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
      const { client: c, sessionId } = await connectClient('codex', { model: 'gpt-5.3-codex-spark' });
      client = c;
      expect(sessionId).toBeTruthy();

      // 프롬프트 전송 → 정상 응답 확인
      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');

      // disconnect → Codex native 프로세스 종료
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
      expect(toolCalls).toContain('test-math/add_numbers');
      expect(response).not.toMatch(/도구.*(없|못 찾|찾을 수)|tool.*not.*found|lazy[- ]?load/i);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // 모델별 프롬프트
  // ═══════════════════════════════════════════════

  describe('모델별 프롬프트', () => {
    it.each(['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.4'])(
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
    it.each(['low', 'medium', 'high', 'xhigh'])(
      'CLI: effort %s → 프롬프트 → 응답 검증',
      async (effort) => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'codex', '-e', effort, SIMPLE_PROMPT],
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

      expect(resetResult.protocol).toBe('codex-app-server');
      expect(secondThreadId).toBeTruthy();
      expect(secondThreadId).not.toBe(firstThreadId);
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
