import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { NewSessionResponse } from '@agentclientprotocol/sdk';

// ─── AcpConnection mock ─────────────────────────────────

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockEndSession = vi.fn();
const mockReconnectSession = vi.fn();
const mockSetMode = vi.fn();
const mockSetModel = vi.fn();
const mockRemoveAllListeners = vi.fn();

function createMockAcpConnection(): EventEmitter & Record<string, unknown> {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    connect: mockConnect,
    disconnect: mockDisconnect,
    endSession: mockEndSession,
    reconnectSession: mockReconnectSession,
    setMode: mockSetMode,
    setModel: mockSetModel,
    connectionState: 'ready',
    removeAllListeners: mockRemoveAllListeners,
    canResetSession: true,
  });
  return emitter as EventEmitter & Record<string, unknown>;
}

vi.mock('../../src/connection/AcpConnection.js', () => ({
  AcpConnection: vi.fn(() => createMockAcpConnection()),
}));

vi.mock('../../src/detector/CliDetector.js', () => ({
  CliDetector: vi.fn(() => ({
    detectAll: vi.fn().mockResolvedValue([]),
    getPreferred: vi.fn().mockResolvedValue(null),
  })),
}));

const { UnifiedClaudeAgentClient } = await import('../../src/client/UnifiedClaudeAgentClient.js');

// ─── 헬퍼 ────────────────────────────────────────────────

const initialSession: NewSessionResponse = {
  sessionId: 'initial-session',
} as NewSessionResponse;

const newSession: NewSessionResponse = {
  sessionId: 'new-session-after-reset',
} as NewSessionResponse;

/** 클라이언트를 연결 상태로 만드는 헬퍼 */
async function createConnectedClient(cwd = '/workspace'): Promise<UnifiedClaudeAgentClient> {
  mockConnect.mockResolvedValue(initialSession);
  const client = new UnifiedClaudeAgentClient();
  await client.connect({ cwd, cli: 'claude' });
  vi.clearAllMocks();
  // reconnect mock 재설정
  mockEndSession.mockResolvedValue(undefined);
  mockReconnectSession.mockResolvedValue(newSession);
  return client;
}

// ─── 테스트 ──────────────────────────────────────────────

describe('resetSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('연결 없이 resetSession() 호출 → 명확한 에러', async () => {
    const client = new UnifiedClaudeAgentClient();

    await expect(client.resetSession()).rejects.toThrow('연결되어 있지 않습니다');
  });

  it('정상 resetSession() → 새 sessionId 반환', async () => {
    const client = await createConnectedClient('/workspace');

    const result = await client.resetSession();

    expect(result.session?.sessionId).toBe('new-session-after-reset');
    expect(result.cli).toBe('claude');
    expect(result.protocol).toBe('acp');
  });

  it('cwd 지정 시 해당 cwd로 reconnectSession() 호출', async () => {
    const client = await createConnectedClient('/workspace');

    await client.resetSession('/new-workspace');

    expect(mockReconnectSession).toHaveBeenCalledWith(
      '/new-workspace',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('cwd 미지정 시 sessionCwd 재사용', async () => {
    const client = await createConnectedClient('/original-workspace');

    await client.resetSession();

    expect(mockReconnectSession).toHaveBeenCalledWith(
      '/original-workspace',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('resetSession 후 내부 sessionId 갱신', async () => {
    const client = await createConnectedClient('/workspace');

    await client.resetSession();

    const info = client.getConnectionInfo();
    expect(info.sessionId).toBe('new-session-after-reset');
  });

  it('endSession이 먼저 호출된 후 reconnectSession이 호출됨', async () => {
    const client = await createConnectedClient('/workspace');

    const callOrder: string[] = [];
    mockEndSession.mockImplementation(async () => { callOrder.push('endSession'); });
    mockReconnectSession.mockImplementation(async () => {
      callOrder.push('reconnectSession');
      return newSession;
    });

    await client.resetSession();

    expect(callOrder).toEqual(['endSession', 'reconnectSession']);
  });
});
