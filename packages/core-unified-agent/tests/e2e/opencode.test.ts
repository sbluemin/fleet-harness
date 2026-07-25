/**
 * E2E: OpenCode ACP SDK 테스트
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { IUnifiedAgentClient } from '../../src/index.js';
import type { CliType } from '../../src/config/CliConfigs.js';
import {
  connectClient,
  isCliInstalled,
  sendAndCollect,
  SESSION_RECALL_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SIMPLE_PROMPT,
} from './helpers.js';

const installed = isCliInstalled('opencode');
const providers = [
  { cli: 'opencode-go', label: 'OpenCode Go' },
] as const satisfies readonly { cli: CliType; label: string }[];

describe.skipIf(!installed)('E2E: OpenCode ACP SDK', () => {
  let client: IUnifiedAgentClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });

  for (const provider of providers) {
    it(`${provider.label} 연결 → 프롬프트 → 응답을 검증한다`, async () => {
      const connected = await connectClient(provider.cli);
      client = connected.client;

      expect(connected.sessionId).toBeTruthy();
      const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
      expect(response).toContain('2');
    }, 180_000);

    it(`${provider.label} disconnect 후 상태와 프로세스를 정리한다`, async () => {
      const connected = await connectClient(provider.cli);
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

    it(`${provider.label} 기존 세션을 SDK로 재개한다`, async () => {
      const first = await connectClient(provider.cli);
      client = first.client;
      await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
      await client.disconnect();
      client = null;

      const second = await connectClient(provider.cli, {
        sessionId: first.sessionId ?? undefined,
      });
      client = second.client;
      const recalled = await sendAndCollect(client, SESSION_RECALL_PROMPT);
      expect(recalled.response).toContain('42');
      expect(second.sessionId).toBe(first.sessionId);
    }, 360_000);
  }
});
