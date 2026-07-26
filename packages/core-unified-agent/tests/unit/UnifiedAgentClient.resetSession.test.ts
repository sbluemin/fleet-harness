import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { NewSessionResponse } from '@agentclientprotocol/sdk';

// ─── AcpConnection mock ─────────────────────────────────

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockEndSession = vi.fn();
const mockReconnectSession = vi.fn();
const mockLoadSession = vi.fn();
const mockSendPrompt = vi.fn();
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
    loadSession: mockLoadSession,
    sendPrompt: mockSendPrompt,
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
async function createConnectedClient(cwd = '/workspace'): Promise<InstanceType<typeof UnifiedClaudeAgentClient>> {
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

  it('Claude systemPrompt는 ACP meta가 아닌 fresh 세션의 첫 프롬프트에 한 번만 prepend한다', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    const client = new UnifiedClaudeAgentClient();

    await client.connect({ cwd: '/workspace', cli: 'claude', systemPrompt: 'Tier-2 지침' });
    await client.sendMessage('첫 요청');
    await client.sendMessage('두 번째 요청');

    expect(mockConnect).toHaveBeenCalledWith('/workspace', undefined, [], undefined, undefined, undefined);
    expect(mockSendPrompt).toHaveBeenNthCalledWith(1, 'initial-session', [
      { type: 'text', text: 'Tier-2 지침' },
      { type: 'text', text: '첫 요청' },
    ]);
    expect(mockSendPrompt).toHaveBeenNthCalledWith(2, 'initial-session', '두 번째 요청');
  });

  it('Claude replace mode는 ACP meta로 전달하고 첫 프롬프트에는 prepend하지 않는다', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    const client = new UnifiedClaudeAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'claude',
      systemPrompt: '대체 지침',
      systemPromptMode: 'replace',
    });
    await client.sendMessage('첫 요청');

    expect(mockConnect).toHaveBeenCalledWith(
      '/workspace',
      undefined,
      [],
      '대체 지침',
      undefined,
      undefined,
    );
    expect(mockSendPrompt).toHaveBeenCalledWith('initial-session', '첫 요청');
  });

  it('Claude resetSession은 systemPrompt를 새 세션의 첫 프롬프트에 다시 prepend한다', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockReconnectSession.mockResolvedValue(newSession);
    mockSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    const client = new UnifiedClaudeAgentClient();

    await client.connect({ cwd: '/workspace', cli: 'claude', systemPrompt: 'Tier-2 지침' });
    await client.resetSession();
    await client.sendMessage('리셋 후 요청');

    expect(mockReconnectSession).toHaveBeenCalledWith('/workspace', undefined, undefined, undefined, undefined, undefined);
    expect(mockSendPrompt).toHaveBeenCalledWith('new-session-after-reset', [
      { type: 'text', text: 'Tier-2 지침' },
      { type: 'text', text: '리셋 후 요청' },
    ]);
  });

  it('Claude replace mode resetSession은 ACP meta를 다시 전달하고 prepend하지 않는다', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockReconnectSession.mockResolvedValue(newSession);
    mockSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    const client = new UnifiedClaudeAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'claude',
      systemPrompt: '대체 지침',
      systemPromptMode: 'replace',
    });
    await client.resetSession();
    await client.sendMessage('리셋 후 요청');

    expect(mockReconnectSession).toHaveBeenCalledWith(
      '/workspace',
      undefined,
      undefined,
      '대체 지침',
      undefined,
      undefined,
    );
    expect(mockSendPrompt).toHaveBeenCalledWith('new-session-after-reset', '리셋 후 요청');
  });

  it('replace mode를 미지원 백엔드로 요청하면 정확한 에러로 거부한다', async () => {
    const client = new UnifiedClaudeAgentClient();

    await expect(client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '대체 지침',
      systemPromptMode: 'replace',
    })).rejects.toThrow(
      'system prompt replacement is not supported by the "codex" backend',
    );
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('Claude failed-first-send는 Tier-2를 재시도하고 성공 뒤에는 반복하지 않는다', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockSendPrompt
      .mockRejectedValueOnce(new Error('transient send failure'))
      .mockResolvedValue({ stopReason: 'endTurn' });
    const client = new UnifiedClaudeAgentClient();

    await client.connect({ cwd: '/workspace', cli: 'claude', systemPrompt: 'Tier-2 지침' });
    await expect(client.sendMessage('첫 요청')).rejects.toThrow('transient send failure');
    await client.sendMessage('재시도 요청');
    await client.sendMessage('다음 요청');

    expect(mockSendPrompt).toHaveBeenNthCalledWith(1, 'initial-session', [
      { type: 'text', text: 'Tier-2 지침' },
      { type: 'text', text: '첫 요청' },
    ]);
    expect(mockSendPrompt).toHaveBeenNthCalledWith(2, 'initial-session', [
      { type: 'text', text: 'Tier-2 지침' },
      { type: 'text', text: '재시도 요청' },
    ]);
    expect(mockSendPrompt).toHaveBeenNthCalledWith(3, 'initial-session', '다음 요청');
  });

  it('Claude resumed and loaded sessions send user content only', async () => {
    mockConnect.mockResolvedValue(initialSession);
    mockLoadSession.mockResolvedValue({});
    mockSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    const resumed = new UnifiedClaudeAgentClient();

    await resumed.connect({ cwd: '/workspace', cli: 'claude', sessionId: 'existing', systemPrompt: 'Tier-2 지침' });
    await resumed.sendMessage('재개 요청');

    const loaded = new UnifiedClaudeAgentClient();
    await loaded.connect({ cwd: '/workspace', cli: 'claude', systemPrompt: 'Tier-2 지침' });
    await loaded.loadSession('loaded-session');
    await loaded.sendMessage('로드 요청');

    expect(mockSendPrompt).toHaveBeenNthCalledWith(1, 'initial-session', '재개 요청');
    expect(mockSendPrompt).toHaveBeenNthCalledWith(2, 'loaded-session', '로드 요청');
  });
});
