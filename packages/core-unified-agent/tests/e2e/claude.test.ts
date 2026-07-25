/**
 * E2E: Claude ACP SDK 테스트
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { IUnifiedAgentClient } from '../../src/index.js';
import {
  connectClient,
  isCliInstalled,
  sendAndCollect,
  sendAndMeasure,
  SESSION_RECALL_PROMPT,
  SESSION_REMEMBER_PROMPT,
  SIMPLE_PROMPT,
} from './helpers.js';

const installed = isCliInstalled('claude');

describe.skipIf(!installed)('E2E: Claude ACP SDK', () => {
  let client: IUnifiedAgentClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });

  it('ACP 연결 → 프롬프트 → 응답을 검증한다', async () => {
    const connected = await connectClient('claude');
    client = connected.client;

    expect(connected.sessionId).toBeTruthy();
    const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
    expect(response).toContain('2');
  }, 180_000);

  it('disconnect 후 상태와 프로세스를 정리한다', async () => {
    const connected = await connectClient('claude', { model: 'haiku' });
    client = connected.client;

    const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
    expect(response).toContain('2');
    await client.disconnect();

    expect(client.getConnectionInfo()).toMatchObject({
      cli: null,
      sessionId: null,
      state: 'disconnected',
    });
    await expect(client.sendMessage(SIMPLE_PROMPT)).rejects.toThrow();
    client = null;
  }, 180_000);

  it('connect(effort=max)가 effort=low보다 더 긴 응답을 유발한다', async () => {
    const prompt = '다음 문제를 단계별로 추론하여 답하시오: 어떤 수에 7을 더하고 3을 곱한 뒤 5를 빼면 31이 된다. 이 수는 무엇인가?';
    const low = await connectClient('claude', { model: 'sonnet', effort: 'low' });
    const lowResult = await sendAndMeasure(low.client, prompt);
    await low.client.disconnect();

    const max = await connectClient('claude', { model: 'sonnet', effort: 'max' });
    const maxResult = await sendAndMeasure(max.client, prompt);
    await max.client.disconnect();

    expect(maxResult.response.length).toBeGreaterThanOrEqual(
      Math.floor(lowResult.response.length * 1.3),
    );
  }, 240_000);

  it.each([true, false])('strictMcp=%s로 연결한다', async (strictMcp) => {
    const connected = await connectClient('claude', { strictMcp });
    client = connected.client;

    expect(connected.sessionId).toBeTruthy();
    const { response } = await sendAndCollect(client, SIMPLE_PROMPT);
    expect(response).toContain('2');
  }, 180_000);

  it('기존 세션을 SDK로 재개한다', async () => {
    const first = await connectClient('claude');
    client = first.client;
    const remembered = await sendAndCollect(client, SESSION_REMEMBER_PROMPT);
    expect(remembered.response.length).toBeGreaterThan(0);
    await client.disconnect();
    client = null;

    const second = await connectClient('claude', {
      sessionId: first.sessionId ?? undefined,
    });
    client = second.client;
    const recalled = await sendAndCollect(client, SESSION_RECALL_PROMPT);
    expect(recalled.response).toContain('42');
    expect(second.sessionId).toBe(first.sessionId);
  }, 360_000);
});
