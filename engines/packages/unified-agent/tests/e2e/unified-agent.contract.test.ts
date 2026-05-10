/**
 * E2E: UnifiedAgent 빌더 공통 외부 계약 테스트
 *
 * 각 CLI는 서로 다른 connection 구현을 사용할 수 있지만,
 * UnifiedAgent 빌더를 사용하는 외부 호출자는 동일한 기대 동작을 관찰해야 합니다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  UnifiedAgent,
  type IUnifiedAgentClient,
} from '../../src/index.js';
import type { CliType, ProtocolType } from '../../src/types/config.js';
import {
  isCliInstalled,
  SIMPLE_PROMPT,
  withTimeout,
} from './helpers.js';

interface ContractCase {
  cli: CliType;
  expectedProtocol: ProtocolType;
  model?: string;
  supportsResetSession: boolean;
}

const CONTRACT_CASES: ContractCase[] = [
  {
    cli: 'claude',
    expectedProtocol: 'acp',
    model: 'haiku',
    supportsResetSession: true,
  },
  {
    cli: 'codex',
    expectedProtocol: 'codex-app-server',
    model: 'gpt-5.3-codex-spark',
    supportsResetSession: true,
  },
  {
    cli: 'gemini',
    expectedProtocol: 'acp',
    model: 'gemini-3-flash-preview',
    supportsResetSession: false,
  },
];

for (const contractCase of CONTRACT_CASES) {
  const installed = isCliInstalled(contractCase.cli);

  describe.skipIf(!installed)(`UnifiedAgent contract: ${contractCase.cli}`, () => {
    let client: IUnifiedAgentClient | null = null;

    afterEach(async () => {
      if (client) {
        await client.disconnect();
        client = null;
      }
    });

    it('connect()가 공통 연결 정보를 동일한 형태로 노출한다', async () => {
      client = await connectContractClient(contractCase);

      const info = client.getConnectionInfo();
      expect(info.cli).toBe(contractCase.cli);
      expect(info.protocol).toBe(contractCase.expectedProtocol);
      expect(info.sessionId).toBeTruthy();
      expect(info.state).toBe('ready');
    }, 180_000);

    it('sendMessage()가 응답 청크와 promptComplete 이후 resolve된다', async () => {
      client = await connectContractClient(contractCase);
      const sessionId = client.getConnectionInfo().sessionId;
      const chunks: string[] = [];
      const completedSessions: string[] = [];

      client.on('messageChunk', (text) => {
        chunks.push(text);
      });
      client.on('promptComplete', (completedSessionId) => {
        completedSessions.push(completedSessionId);
      });

      await withTimeout(
        client.sendMessage(SIMPLE_PROMPT),
        180_000,
        `${contractCase.cli} sendMessage`,
      );

      expect(chunks.join('')).toContain('2');
      expect(completedSessions).toContain(sessionId);
      expect(client.getConnectionInfo().sessionId).toBe(sessionId);
      expect(client.getConnectionInfo().state).toBe('ready');
    }, 180_000);

    it('resetSession() 지원 여부를 공통 계약으로 명확히 드러낸다', async () => {
      client = await connectContractClient(contractCase);
      const firstSessionId = client.getConnectionInfo().sessionId;
      expect(firstSessionId).toBeTruthy();

      if (!contractCase.supportsResetSession) {
        await expect(client.resetSession()).rejects.toThrow('세션 리셋을 지원하지 않습니다');
        expect(client.getConnectionInfo().sessionId).toBe(firstSessionId);
        return;
      }

      const result = await withTimeout(
        client.resetSession(),
        180_000,
        `${contractCase.cli} resetSession`,
      );
      const secondSessionId = client.getConnectionInfo().sessionId;

      expect(result.cli).toBe(contractCase.cli);
      expect(result.protocol).toBe(contractCase.expectedProtocol);
      expect(secondSessionId).toBeTruthy();
      expect(secondSessionId).not.toBe(firstSessionId);
      expect(client.getConnectionInfo().state).toBe('ready');
    }, 180_000);

    it('disconnect() 후 공통 연결 상태를 초기화하고 재전송을 거부한다', async () => {
      client = await connectContractClient(contractCase);

      await client.disconnect();

      const info = client.getConnectionInfo();
      expect(info.state).toBe('disconnected');
      expect(info.cli).toBeNull();
      expect(info.protocol).toBeNull();
      expect(info.sessionId).toBeNull();
      await expect(client.sendMessage(SIMPLE_PROMPT)).rejects.toThrow();

      client = null;
    }, 180_000);
  });
}

async function connectContractClient(
  contractCase: ContractCase,
): Promise<IUnifiedAgentClient> {
  const client = await UnifiedAgent.build({ cli: contractCase.cli });
  client.on('error', () => {});

  await withTimeout(
    client.connect({
      cwd: process.cwd(),
      cli: contractCase.cli,
      autoApprove: true,
      model: contractCase.model,
      clientInfo: { name: 'UnifiedAgentContractE2E', version: '1.0.0' },
    }),
    120_000,
    `${contractCase.cli} connect`,
  );

  return client;
}
