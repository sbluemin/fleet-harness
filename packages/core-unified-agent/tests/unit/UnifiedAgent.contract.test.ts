import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliType } from '../../src/config/CliConfigs.js';
import type { ProtocolType } from '../../src/types/config.js';

const mockAcpConnect = vi.fn();
const mockAcpDisconnect = vi.fn();
const mockAcpEndSession = vi.fn();
const mockAcpReconnectSession = vi.fn();
const mockAcpSendPrompt = vi.fn();

const mockCodexConnect = vi.fn();
const mockCodexDisconnect = vi.fn();
const mockCodexResetSession = vi.fn();
const mockCodexSendMessage = vi.fn();
const mockCodexEndSession = vi.fn();
const mockGetPreferred = vi.fn();

function createMockAcpConnection(): EventEmitter & Record<string, unknown> {
  const connection = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(connection, {
    connect: mockAcpConnect,
    disconnect: mockAcpDisconnect,
    endSession: mockAcpEndSession,
    reconnectSession: mockAcpReconnectSession,
    sendPrompt: async (sessionId: string, content: unknown) => {
      const result = await mockAcpSendPrompt(sessionId, content);
      connection.emit('messageChunk', '2', sessionId);
      connection.emit('promptComplete', sessionId);
      return result;
    },
    connectionState: 'ready',
    canResetSession: true,
    removeAllListeners: vi.fn(),
  });
  return connection;
}

function createMockCodexConnection(): EventEmitter & Record<string, unknown> {
  const connection = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(connection, {
    connect: async (...args: unknown[]) => {
      const result = await mockCodexConnect(...args);
      if (result?.thread?.id) connection.sessionId = result.thread.id;
      return result;
    },
    disconnect: mockCodexDisconnect,
    endSession: mockCodexEndSession,
    resetSession: async (...args: unknown[]) => {
      const result = await mockCodexResetSession(...args);
      connection.sessionId = result.thread.id;
      return result;
    },
    sendMessage: async (content: unknown) => {
      const result = await mockCodexSendMessage(content);
      const sessionId = connection.sessionId as string;
      connection.emit('messageChunk', '2', sessionId);
      connection.emit('promptComplete', sessionId);
      return result;
    },
    cancelPrompt: vi.fn(),
    setPendingModel: vi.fn(),
    setPendingServiceTier: vi.fn(),
    setPendingEffort: vi.fn(),
    connectionState: 'ready',
    sessionId: null,
  });
  return connection;
}

vi.mock('../../src/connection/AcpConnection.js', () => ({
  AcpConnection: vi.fn(() => createMockAcpConnection()),
}));

vi.mock('../../src/connection/CodexAppServerConnection.js', () => ({
  CodexAppServerConnection: vi.fn(() => createMockCodexConnection()),
}));

vi.mock('../../src/detector/CliDetector.js', () => ({
  CliDetector: vi.fn(() => ({
    detectAll: vi.fn().mockResolvedValue([]),
    getPreferred: mockGetPreferred,
  })),
}));

const { UnifiedAgent } = await import('../../src/client/UnifiedAgent.js');

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
    model: 'gpt-5.6-sol',
    supportsResetSession: true,
  },
];

describe('UnifiedAgent builder contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcpConnect.mockResolvedValue({ sessionId: 'claude-session-1' });
    mockAcpDisconnect.mockResolvedValue(undefined);
    mockAcpEndSession.mockResolvedValue(undefined);
    mockAcpReconnectSession.mockResolvedValue({ sessionId: 'claude-session-2' });
    mockAcpSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    mockCodexConnect.mockResolvedValue({ thread: { id: 'codex-thread-1' } });
    mockCodexDisconnect.mockResolvedValue(undefined);
    mockCodexEndSession.mockResolvedValue(undefined);
    mockCodexResetSession.mockResolvedValue({ thread: { id: 'codex-thread-2' } });
    mockCodexSendMessage.mockResolvedValue(undefined);
    mockGetPreferred.mockResolvedValue(null);
  });

  for (const contractCase of CONTRACT_CASES) {
    describe(contractCase.cli, () => {
      let client: Awaited<ReturnType<typeof UnifiedAgent.build>> | null = null;

      afterEach(async () => {
        if (client) {
          await client.disconnect();
          client = null;
        }
      });

      it('connect()가 공통 연결 정보를 동일한 형태로 노출한다', async () => {
        client = await UnifiedAgent.build({ cli: contractCase.cli });
        await client.connect({
          cwd: '/workspace',
          cli: contractCase.cli,
          autoApprove: true,
          model: contractCase.model,
          clientInfo: { name: 'UnifiedAgentContractUnit', version: '1.0.0' },
        });

        const info = client.getConnectionInfo();
        expect(info.cli).toBe(contractCase.cli);
        expect(info.protocol).toBe(contractCase.expectedProtocol);
        expect(info.sessionId).toBeTruthy();
        expect(info.state).toBe('ready');
      });

      it('sendMessage()가 응답 청크와 promptComplete 이후 resolve된다', async () => {
        client = await UnifiedAgent.build({ cli: contractCase.cli });
        await client.connect({
          cwd: '/workspace',
          cli: contractCase.cli,
          autoApprove: true,
          model: contractCase.model,
        });
        const sessionId = client.getConnectionInfo().sessionId;
        const chunks: string[] = [];
        const completedSessions: string[] = [];

        client.on('messageChunk', (text) => {
          chunks.push(text);
        });
        client.on('promptComplete', (completedSessionId) => {
          completedSessions.push(completedSessionId);
        });

        await client.sendMessage('1+1');

        expect(chunks.join('')).toContain('2');
        expect(completedSessions).toContain(sessionId);
        expect(client.getConnectionInfo().sessionId).toBe(sessionId);
        expect(client.getConnectionInfo().state).toBe('ready');
      });

      it('resetSession() 지원 여부를 공통 계약으로 명확히 드러낸다', async () => {
        client = await UnifiedAgent.build({ cli: contractCase.cli });
        await client.connect({
          cwd: '/workspace',
          cli: contractCase.cli,
          autoApprove: true,
          model: contractCase.model,
        });
        const firstSessionId = client.getConnectionInfo().sessionId;
        expect(firstSessionId).toBeTruthy();

        if (!contractCase.supportsResetSession) {
          await expect(client.resetSession()).rejects.toThrow('세션 리셋을 지원하지 않습니다');
          expect(client.getConnectionInfo().sessionId).toBe(firstSessionId);
          return;
        }

        const result = await client.resetSession();
        const secondSessionId = client.getConnectionInfo().sessionId;

        expect(result.cli).toBe(contractCase.cli);
        expect(result.protocol).toBe(contractCase.expectedProtocol);
        expect(secondSessionId).toBeTruthy();
        expect(secondSessionId).not.toBe(firstSessionId);
        expect(client.getConnectionInfo().state).toBe('ready');
      });

      it('disconnect() 후 공통 연결 상태를 초기화하고 재전송을 거부한다', async () => {
        client = await UnifiedAgent.build({ cli: contractCase.cli });
        await client.connect({
          cwd: '/workspace',
          cli: contractCase.cli,
          autoApprove: true,
          model: contractCase.model,
        });

        await client.disconnect();

        const info = client.getConnectionInfo();
        expect(info.state).toBe('disconnected');
        expect(info.cli).toBeNull();
        expect(info.protocol).toBeNull();
        expect(info.sessionId).toBeNull();
        await expect(client.sendMessage('1+1')).rejects.toThrow();

        client = null;
      });
    });
  }
});
