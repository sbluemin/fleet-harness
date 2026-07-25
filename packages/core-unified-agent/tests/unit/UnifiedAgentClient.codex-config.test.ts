import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockEndSession = vi.fn();
const mockResetSession = vi.fn();
const mockLoadSession = vi.fn();
const mockSendMessage = vi.fn();
const mockCancelPrompt = vi.fn();
const mockSetPendingModel = vi.fn();
const mockSetPendingServiceTier = vi.fn();
const mockSetPendingEffort = vi.fn();

function createMockConnection(): EventEmitter & Record<string, unknown> {
  const connection = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(connection, {
    connect: async (...args: unknown[]) => {
      const result = await mockConnect(...args);
      if (result?.thread?.id) connection.sessionId = result.thread.id;
      return result;
    },
    disconnect: mockDisconnect,
    endSession: mockEndSession,
    resetSession: async (...args: unknown[]) => {
      const result = await mockResetSession(...args);
      connection.sessionId = result.thread.id;
      return result;
    },
    loadSession: async (...args: unknown[]) => {
      const result = await mockLoadSession(...args);
      connection.sessionId = result.thread.id;
      return result;
    },
    sendMessage: mockSendMessage,
    cancelPrompt: mockCancelPrompt,
    setPendingModel: mockSetPendingModel,
    setPendingServiceTier: mockSetPendingServiceTier,
    setPendingEffort: mockSetPendingEffort,
    connectionState: 'ready',
    sessionId: null,
  });
  return connection;
}

vi.mock('../../src/connection/CodexAppServerConnection.js', () => ({
  CodexAppServerConnection: vi.fn(() => createMockConnection()),
}));

vi.mock('../../src/detector/CliDetector.js', () => ({
  CliDetector: vi.fn(() => ({
    detectAll: vi.fn().mockResolvedValue([]),
    getPreferred: vi.fn().mockResolvedValue(null),
  })),
}));

const { UnifiedCodexAgentClient } = await import('../../src/client/UnifiedCodexAgentClient.js');
const { CodexAppServerConnection } = await import('../../src/connection/CodexAppServerConnection.js');

describe('UnifiedCodexAgentClient App Server config staging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({ thread: { id: 'codex-thread-1' } });
    mockDisconnect.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue(undefined);
    mockResetSession.mockResolvedValue({ thread: { id: 'codex-thread-2' } });
    mockLoadSession.mockResolvedValue({ thread: { id: 'codex-thread-9' } });
    mockSendMessage.mockResolvedValue(undefined);
    mockCancelPrompt.mockResolvedValue(undefined);
  });

  it('Codex는 항상 App Server로 연결한다', async () => {
    const client = new UnifiedCodexAgentClient();
    const result = await client.connect({ cwd: '/workspace', cli: 'codex' });

    expect(CodexAppServerConnection).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      cli: 'codex',
      protocol: 'codex-app-server',
      session: { sessionId: 'codex-thread-1' },
    });
  });

  it('세션 ID 없이 연결되면 연결을 정리하고 실패한다', async () => {
    mockConnect.mockResolvedValue({ thread: { id: '' } });
    const client = new UnifiedCodexAgentClient();

    await expect(client.connect({ cwd: '/workspace', cli: 'codex' })).rejects.toThrow(
      '[codex] App Server 연결에서 유효한 세션 ID를 받지 못했습니다.',
    );
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(client.getConnectionInfo().state).toBe('disconnected');
  });

  it('지원하지 않는 model+effort 조합은 spawn 전에 거부한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await expect(client.connect({
      cwd: '/workspace',
      cli: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'ultra',
    })).rejects.toThrow(
      'codex/gpt-5.6-luna 모델은 effort "ultra"을(를) 지원하지 않습니다. 사용 가능: low, medium, high, xhigh, max',
    );
    expect(CodexAppServerConnection).not.toHaveBeenCalled();
  });

  it('systemPrompt를 developerInstructions가 아니라 첫 프롬프트에 한 번만 prepend한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '개발자 지침',
      model: 'gpt-5.5',
    });

    expect(mockConnect).toHaveBeenCalledWith({
      developerInstructions: undefined,
      model: 'gpt-5.5',
      serviceTier: undefined,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    await client.sendMessage('첫 요청');
    await client.sendMessage('두 번째 요청');
    expect(mockSendMessage).toHaveBeenNthCalledWith(1, [
      { type: 'text', text: '개발자 지침', text_elements: [] },
      { type: 'text', text: '첫 요청', text_elements: [] },
    ]);
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, [
      { type: 'text', text: '두 번째 요청', text_elements: [] },
    ]);
  });

  it('첫 전송 실패 시 systemPrompt를 재시도하고 성공 후에는 반복하지 않는다', async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error('transient send failure'))
      .mockResolvedValue(undefined);
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex', systemPrompt: 'Tier-2 지침' });

    await expect(client.sendMessage('첫 요청')).rejects.toThrow('transient send failure');
    await client.sendMessage('재시도 요청');
    await client.sendMessage('다음 요청');

    expect(mockSendMessage).toHaveBeenNthCalledWith(2, [
      { type: 'text', text: 'Tier-2 지침', text_elements: [] },
      { type: 'text', text: '재시도 요청', text_elements: [] },
    ]);
    expect(mockSendMessage).toHaveBeenNthCalledWith(3, [
      { type: 'text', text: '다음 요청', text_elements: [] },
    ]);
  });

  it('loadSession 이후에는 사용자 content만 전송한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex', systemPrompt: 'Tier-2 지침' });
    await client.loadSession('loaded-thread');
    await client.sendMessage('로드 요청');

    expect(mockSendMessage).toHaveBeenCalledWith([
      { type: 'text', text: '로드 요청', text_elements: [] },
    ]);
  });

  it('MCP 서버 설정을 App Server 시작 -c 인자와 readiness 대상에 반영한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      mcpServers: [{
        type: 'http',
        name: 'test-math',
        url: 'http://127.0.0.1:1234',
        toolTimeout: 180,
      }],
    });

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      mcpServerNames: ['test-math'],
      args: expect.arrayContaining([
        'mcp_servers.test-math.url="http://127.0.0.1:1234"',
        'mcp_servers.test-math.tool_timeout_sec=180',
      ]),
    }));
  });

  it('configOverrides의 MCP 서버도 readiness 대상으로 등록한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      configOverrides: ['mcp_servers.fleet-tools.url="http://127.0.0.1:54300"'],
    });

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      mcpServerNames: ['fleet-tools'],
    }));
  });

  it('재개 세션에는 systemPrompt를 다시 전달하지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();
    const result = await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      sessionId: 'codex-thread-existing',
      systemPrompt: '재개 지침',
      model: 'gpt-5.5',
    });

    expect(mockConnect).toHaveBeenCalledWith({
      skipThreadStart: true,
      model: 'gpt-5.5',
      serviceTier: undefined,
    });
    expect(mockLoadSession).toHaveBeenCalledWith('codex-thread-existing', {
      cwd: '/workspace',
      model: 'gpt-5.5',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: undefined,
      config: undefined,
    });
    expect(result.session).toEqual({ sessionId: 'codex-thread-9' });
    await client.sendMessage('재개 요청');
    expect(mockSendMessage).toHaveBeenCalledWith([
      { type: 'text', text: '재개 요청', text_elements: [] },
    ]);
  });

  it('Fast 자산을 기본 모델과 priority tier로 연결한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      model: 'gpt-5.6-sol-fast',
    });

    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    }));
  });

  it('setModel은 Fast tier를 다음 turn에 적용하고 일반 모델 선택 시 tier를 해제한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex' });

    await client.setModel('gpt-5.6-terra-fast');
    await client.sendMessage('fast');
    expect(mockSetPendingModel).toHaveBeenNthCalledWith(1, 'gpt-5.6-terra');
    expect(mockSetPendingServiceTier).toHaveBeenNthCalledWith(1, 'priority');

    await client.setModel('gpt-5.5');
    await client.sendMessage('standard');
    expect(mockSetPendingModel).toHaveBeenNthCalledWith(2, 'gpt-5.5');
    expect(mockSetPendingServiceTier).toHaveBeenNthCalledWith(2, null);
  });

  it('연결 effort를 첫 turn에 한 번만 적용한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex', effort: 'high' });
    await client.sendMessage('첫 요청');
    await client.sendMessage('두 번째 요청');

    expect(mockSetPendingEffort).toHaveBeenCalledWith('high');
    expect(mockSetPendingEffort).toHaveBeenCalledTimes(1);
  });

  it('resetSession은 Fast 모델과 tier를 유지하고 systemPrompt를 다음 첫 turn에 적용한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      yoloMode: false,
      systemPrompt: '초기 지침',
      model: 'gpt-5.6-luna-fast',
    });
    await client.resetSession();

    expect(mockResetSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      model: 'gpt-5.6-luna',
      serviceTier: 'priority',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      developerInstructions: undefined,
      config: undefined,
    });
    await client.sendMessage('리셋 후 요청');
    expect(mockSendMessage).toHaveBeenCalledWith([
      { type: 'text', text: '초기 지침', text_elements: [] },
      { type: 'text', text: '리셋 후 요청', text_elements: [] },
    ]);
  });

  it('setMode와 thread config를 다음 resetSession payload에 반영한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex' });
    await client.setMode('autoEdit');
    await client.setConfigOption('notify', 'false');
    await client.resetSession('/next-workspace');

    expect(mockResetSession).toHaveBeenCalledWith({
      cwd: '/next-workspace',
      model: undefined,
      serviceTier: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: undefined,
      config: { notify: 'false' },
    });
  });

  it('archiveSessionOnDisconnect: true이면 disconnect 전에 endSession(thread/archive)을 호출한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      archiveSessionOnDisconnect: true,
    });

    const callOrder: string[] = [];
    mockEndSession.mockImplementation(async () => {
      callOrder.push('endSession');
    });
    mockDisconnect.mockImplementation(async () => {
      callOrder.push('disconnect');
    });

    await client.disconnect();

    expect(mockEndSession).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['endSession', 'disconnect']);
  });

  it('archiveSessionOnDisconnect 미지정 시 disconnect가 endSession을 호출하지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({ cwd: '/workspace', cli: 'codex' });

    await client.disconnect();

    expect(mockEndSession).not.toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('archiveSessionOnDisconnect: true여도 endSession 실패 시 disconnect는 계속 진행한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      archiveSessionOnDisconnect: true,
    });
    mockEndSession.mockRejectedValue(new Error('archive failed'));

    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(mockEndSession).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('archiveSessionOnDisconnect: true여도 sessionId가 없으면 endSession을 호출하지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      archiveSessionOnDisconnect: true,
    });
    await client.endSession();
    mockEndSession.mockClear();
    mockDisconnect.mockClear();

    await client.disconnect();

    expect(mockEndSession).not.toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
