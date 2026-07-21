/**
 * E2E: OpenCode ACP 테스트
 * OpenCode CLI를 ACP 프로토콜로 연결하여 프롬프트, 모델, 세션 재개를 검증합니다.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isCliInstalled,
  probeCliModelAvailability,
  connectClient,
  sendAndCollect,
  runCli,
  SIMPLE_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SESSION_RECALL_PROMPT,
} from './helpers.js';
import type { IUnifiedAgentClient } from '../../src/index.js';
import type { CliJsonResult } from './helpers.js';
import type { CliType } from '../../src/config/CliConfigs.js';

const CLI = 'opencode';
const installed = isCliInstalled(CLI);
const OPEN_CODE_PROVIDERS = [
  { cli: 'opencode-go', label: 'OpenCode Go', defaultModel: 'opencode-go/deepseek-v4-flash' },
] as const satisfies readonly { cli: CliType; label: string; defaultModel: string }[];
const defaultModelProbes = Object.fromEntries(
  OPEN_CODE_PROVIDERS.map((provider) => [
    provider.cli,
    installed
      ? probeCliModelAvailability(provider.cli, provider.defaultModel)
      : { available: false },
  ]),
) as Record<(typeof OPEN_CODE_PROVIDERS)[number]['cli'], { available: boolean; reason?: string }>;

describe.skipIf(!installed)('E2E: OpenCode ACP', () => {
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
    for (const provider of OPEN_CODE_PROVIDERS) {
      it(`SDK: ${provider.label} ACP 연결 → 프롬프트 → 응답 검증`, async () => {
        const { client: c, sessionId } = await connectClient(provider.cli);
        client = c;

        expect(sessionId).toBeTruthy();

        const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
        expect(response).toContain('2');
      }, 180_000);

      it(`CLI: ${provider.label} pretty 모드 프롬프트`, async () => {
        const { stdout, stderr, exitCode } = await runCli(
          ['-c', provider.cli, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain('2');
        expect(stderr).toContain('unified-agent');
      }, 180_000);

      it(`CLI: ${provider.label} JSON 모드 프롬프트`, async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '-c', provider.cli, SIMPLE_PROMPT],
        );

        expect(exitCode).toBe(0);
        const result: CliJsonResult = JSON.parse(stdout.trim());
        expect(result.response).toContain('2');
        expect(result.cli).toBe(provider.cli);
        expect(result.sessionId.length).toBeGreaterThan(0);
      }, 180_000);
    }
  });

  // ═══════════════════════════════════════════════
  // Disconnect 후 프로세스 종료
  // ═══════════════════════════════════════════════

  describe('Disconnect 후 프로세스 종료', () => {
    for (const provider of OPEN_CODE_PROVIDERS) {
      it(`SDK: ${provider.label} 연결 → 프롬프트 → disconnect → 프로세스 종료 및 상태 초기화 검증`, async () => {
        const { client: c, sessionId } = await connectClient(provider.cli);
        client = c;
        expect(sessionId).toBeTruthy();

        const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
        expect(response).toContain('2');

        await client.disconnect();

        const info = client.getConnectionInfo();
        expect(info.state).toBe('disconnected');
        expect(info.cli).toBeNull();
        expect(info.sessionId).toBeNull();

        await expect(client.sendMessage(SIMPLE_PROMPT)).rejects.toThrow();

        client = null;
      }, 180_000);
    }
  });

  // ═══════════════════════════════════════════════
  // 모델별 프롬프트
  // ═══════════════════════════════════════════════

  describe('모델별 프롬프트', () => {
    for (const provider of OPEN_CODE_PROVIDERS) {
      it.skipIf(!defaultModelProbes[provider.cli].available)(
        `CLI: ${provider.label} 기본 모델(${provider.defaultModel}) → 프롬프트 → 응답 검증`,
        async () => {
          const { stdout, exitCode } = await runCli(
            ['--json', '-c', provider.cli, '-m', provider.defaultModel, SIMPLE_PROMPT],
          );

          expect(exitCode).toBe(0);
          const result: CliJsonResult = JSON.parse(stdout.trim());
          expect(result.response).toContain('2');
          expect(result.cli).toBe(provider.cli);
        },
        180_000,
      );
    }
  });

  // ═══════════════════════════════════════════════
  // OpenCode capability
  // ═══════════════════════════════════════════════

  describe('OpenCode capability', () => {
    for (const provider of OPEN_CODE_PROVIDERS) {
      it(`CLI: ${provider.label} list-models JSON에서 reasoning effort 미지원으로 노출된다`, async () => {
        const { stdout, exitCode } = await runCli(
          ['--json', '--list-models', '-c', provider.cli],
        );

        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout.trim()) as Record<string, {
          models: Array<{ effort: { supported: boolean } }>;
        }>;
        expect(result[provider.cli]?.models.every((model) => !model.effort.supported)).toBe(true);
      }, 180_000);
    }
  });

  // ═══════════════════════════════════════════════
  // 세션 재개
  // ═══════════════════════════════════════════════

  describe('세션 재개', () => {
    for (const provider of OPEN_CODE_PROVIDERS) {
      it(`CLI: ${provider.label} 1차 프롬프트 → sessionId → 2차 세션 재개 → 컨텍스트 유지`, async () => {
        const first = await runCli(
          ['--json', '-c', provider.cli, SESSION_REMEMBER_PROMPT],
        );
        expect(first.exitCode).toBe(0);

        const firstResult: CliJsonResult = JSON.parse(first.stdout.trim());
        expect(firstResult.sessionId.length).toBeGreaterThan(0);

        const second = await runCli(
          ['--json', '-c', provider.cli, '-s', firstResult.sessionId, SESSION_RECALL_PROMPT],
          { timeout: 360_000 },
        );
        expect(second.exitCode).toBe(0);

        const secondResult: CliJsonResult = JSON.parse(second.stdout.trim());
        expect(secondResult.response).toContain('42');
        expect(secondResult.sessionId).toBe(firstResult.sessionId);
      }, 360_000);

      it(`SDK: ${provider.label} 1차 연결 → 프롬프트 → disconnect → 2차 세션 복귀(loadSession) → 컨텍스트 유지`, async () => {
        const { client: c1, sessionId: firstSessionId } = await connectClient(provider.cli);
        client = c1;

        expect(firstSessionId).toBeTruthy();

        const { response: firstResponse } = await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
        expect(firstResponse.length).toBeGreaterThan(0);

        await client.disconnect();
        client = null;

        const { client: c2, sessionId: secondSessionId } = await connectClient(provider.cli, {
          sessionId: firstSessionId ?? undefined,
        });
        client = c2;

        const { response: secondResponse } = await sendAndCollect(client, SESSION_RECALL_PROMPT);
        expect(secondResponse).toContain('42');
        expect(secondSessionId).toBe(firstSessionId);
      }, 360_000);
    }
  });
});
