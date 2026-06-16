/**
 * E2E: Claude ACP 테스트
 * Claude CLI를 ACP 프로토콜로 연결하여 프롬프트, 모델, 세션 재개를 검증합니다.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isCliInstalled,
  probeCliModelAvailability,
  connectClient,
  sendAndCollect,
  sendAndMeasure,
  runCli,
  SIMPLE_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SESSION_RECALL_PROMPT,
} from './helpers.js';
import type { IUnifiedAgentClient } from '../../src/index.js';
import type { CliJsonResult } from './helpers.js';

const CLI = 'claude';
const installed = isCliInstalled(CLI);
const opus1mProbe = installed ? probeCliModelAvailability('claude', 'opus[1m]') : { available: false };
const explicitOpus46_1mProbe = installed
  ? probeCliModelAvailability('claude', 'claude-opus-4-6[1m]')
  : { available: false };
const explicitOpus47_1mProbe = installed
  ? probeCliModelAvailability('claude', 'claude-opus-4-7[1m]')
  : { available: false };
const explicitOpus48_1mProbe = installed
  ? probeCliModelAvailability('claude', 'claude-opus-4-8[1m]')
  : { available: false };

describe.skipIf(!installed)('E2E: Claude ACP', () => {
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
    it('SDK: ACP 연결 → 프롬프트 → 응답 검증', async () => {
      const { client: c, sessionId } = await connectClient('claude');
      client = c;

      expect(sessionId).toBeTruthy();

      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');
    }, 180_000);

    it('CLI: pretty 모드 프롬프트', async () => {
      const { stdout, stderr, exitCode } = await runCli(
        ['-c', 'claude', SIMPLE_PROMPT],
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('2');
      // stderr에 상태 헤더 포함
      expect(stderr).toContain('unified-agent');
    }, 180_000);

    it('CLI: JSON 모드 프롬프트', async () => {
      const { stdout, exitCode } = await runCli(
        ['--json', '-c', 'claude', SIMPLE_PROMPT],
      );

      expect(exitCode).toBe(0);
      const result: CliJsonResult = JSON.parse(stdout.trim());
      expect(result.response).toContain('2');
      expect(result.cli).toBe('claude');
      expect(result.sessionId.length).toBeGreaterThan(0);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // Disconnect 후 프로세스 종료
  // ═══════════════════════════════════════════════

  describe('Disconnect 후 프로세스 종료', () => {
    it('SDK: 연결 → 프롬프트 → disconnect → 프로세스 종료 및 상태 초기화 검증', async () => {
      // 최소 모델/effort로 연결
      const { client: c, sessionId } = await connectClient('claude', { model: 'haiku' });
      client = c;
      expect(sessionId).toBeTruthy();

      // 프롬프트 전송 → 정상 응답 확인
      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');

      // disconnect → 프로세스 종료
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
  // 모델별 프롬프트
  // ═══════════════════════════════════════════════

  describe('모델별 프롬프트', () => {
    it.each(['haiku', 'sonnet', 'opus'])(
      'CLI: 모델 %s → 프롬프트 → 응답 검증',
      async (model) => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', model, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );

    it.skipIf(!opus1mProbe.available)(
      'CLI: 모델 opus[1m] → 프롬프트 → 응답 검증',
      async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', 'opus[1m]', SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );

    it.skipIf(!explicitOpus46_1mProbe.available)(
      'CLI: 모델 claude-opus-4-6[1m] → 프롬프트 → 응답 검증',
      async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', 'claude-opus-4-6[1m]', SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );

    it.skipIf(!explicitOpus47_1mProbe.available)(
      'CLI: 모델 claude-opus-4-7[1m] → 프롬프트 → 응답 검증',
      async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', 'claude-opus-4-7[1m]', SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );

    it.skipIf(!explicitOpus48_1mProbe.available)(
      'CLI: 모델 claude-opus-4-8[1m] → 프롬프트 → 응답 검증',
      async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', 'claude-opus-4-8[1m]', SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );
  });

  // ═══════════════════════════════════════════════
  // Claude capability
  // ═══════════════════════════════════════════════

  describe('Claude capability', () => {
    it('CLI: list-models JSON에서 reasoning effort 지원과 레벨이 노출된다', async () => {
      const { stdout, exitCode } = await runCli(
        ['--json', '--list-models', '-c', 'claude'],
      );

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout.trim()) as {
        claude: {
          models: Array<{
            modelId: string;
            effort: { supported: boolean; levels: string[]; default: string };
          }>;
        };
      };
      const sonnet = result.claude.models.find((model) => model.modelId === 'sonnet');
      expect(sonnet?.effort.supported).toBe(true);
      expect(sonnet?.effort.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(sonnet?.effort.default).toBe('medium');
    }, 180_000);

    it('CLI: effort를 주면 Claude는 무시 안내 없이 프롬프트 응답을 계속 동작한다', async () => {
      const { stdout, stderr, exitCode } = await runCli(
        ['-c', 'claude', '-e', 'high', SIMPLE_PROMPT],
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('2');
      expect(stderr).not.toContain('claude CLI는 reasoning effort를 지원하지 않아 --effort=high 를 무시합니다');
    }, 180_000);

    it.each(['low', 'medium', 'high', 'max'])(
      'CLI: sonnet effort %s → 프롬프트 → 응답 검증',
      async (effort) => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', 'claude', '-m', 'sonnet', '-e', effort, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe('claude');
      },
      180_000,
    );

    it('SDK: connect(effort=max)가 effort=low보다 더 긴 응답을 유발한다', async () => {
      // claude CLI 직접 실측에서 effort 차이가 명확히 나타난 다단계 추론 prompt 사용.
      const thinkingPrompt = '다음 문제를 단계별로 추론하여 답하시오: 어떤 수에 7을 더하고 3을 곱한 뒤 5를 빼면 31이 된다. 이 수는 무엇인가?';

      const { client: lowClient, sessionId: lowSessionId } = await connectClient('claude', {
        model: 'sonnet',
        effort: 'low',
      });
      expect(lowSessionId).toBeTruthy();
      const lowResult = await sendAndMeasure(lowClient, thinkingPrompt);
      await lowClient.disconnect();

      const { client: maxClient, sessionId: maxSessionId } = await connectClient('claude', {
        model: 'sonnet',
        effort: 'max',
      });
      expect(maxSessionId).toBeTruthy();
      const maxResult = await sendAndMeasure(maxClient, thinkingPrompt);
      await maxClient.disconnect();

      // direct ACP `_meta` 실측에서 max는 low 대비 평균 2.01× 수준으로 관측되었습니다.
      // Fleet unified-agent SDK 경로에서는 sendMessage stream 수집 특성으로 약 1.44×까지 약화될 수 있어
      // 보수적 1.3× 마진으로 회차별 변동을 흡수합니다(direct ACP 최저 1.71×의 절반 이하 수준으로 안전).
      expect(maxResult.response.length).toBeGreaterThanOrEqual(
        Math.floor(lowResult.response.length * 1.3),
      );
    }, 240_000);
  });

  // ═══════════════════════════════════════════════
  // strictMcp
  // ═══════════════════════════════════════════════

  describe('strictMcp (--strict-mcp-config 인자 주입)', () => {
    it('SDK: strictMcp=true → 연결 → 프롬프트 → 정상 응답', async () => {
      const { client: c, sessionId } = await connectClient('claude', { strictMcp: true });
      client = c;

      expect(sessionId).toBeTruthy();

      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');
    }, 180_000);

    it('SDK: strictMcp=false → 연결 → 프롬프트 → 정상 응답 (디폴트 동등)', async () => {
      const { client: c, sessionId } = await connectClient('claude', { strictMcp: false });
      client = c;

      expect(sessionId).toBeTruthy();

      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');
    }, 180_000);
  });

  // ═══════════════════════════════════════════════
  // 세션 재개
  // ═══════════════════════════════════════════════

  describe('세션 재개', () => {
    it('CLI: 1차 프롬프트 → sessionId → 2차 세션 재개 → 컨텍스트 유지', async () => {
      // 1차: 숫자 기억 요청
      const first = await runCli(
        ['--json', '-c', 'claude', SESSION_REMEMBER_PROMPT],
      );
      expect(first.exitCode).toBe(0);

      const firstResult: CliJsonResult = JSON.parse(first.stdout.trim());
      expect(firstResult.sessionId.length).toBeGreaterThan(0);

      // 2차: 세션 재개하여 기억한 숫자 확인
      const second = await runCli(
        ['--json', '-c', 'claude', '-s', firstResult.sessionId, SESSION_RECALL_PROMPT],
        { timeout: 360_000 },
      );
      expect(second.exitCode).toBe(0);

      const secondResult: CliJsonResult = JSON.parse(second.stdout.trim());
      expect(secondResult.response).toContain('42');
      expect(secondResult.sessionId).toBe(firstResult.sessionId);
    }, 360_000);

    it('SDK: 1차 연결 → 프롬프트 → disconnect → 2차 세션 복귀(loadSession) → 컨텍스트 유지', async () => {
      // 1차: SDK 연결 후 숫자 기억 요청
      const { client: c1, sessionId: firstSessionId } = await connectClient('claude');
      client = c1;

      expect(firstSessionId).toBeTruthy();

      const { response: firstResponse } = await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
      expect(firstResponse.length).toBeGreaterThan(0);

      await client.disconnect();
      client = null;

      // 2차: 동일 sessionId로 loadSession 경로를 거쳐 컨텍스트 확인
      const { client: c2, sessionId: secondSessionId } = await connectClient('claude', {
        sessionId: firstSessionId ?? undefined,
      });
      client = c2;

      const { response: secondResponse } = await sendAndCollect(client, SESSION_RECALL_PROMPT);
      expect(secondResponse).toContain('42');
      expect(secondSessionId).toBe(firstSessionId);
    }, 360_000);
  });
});
