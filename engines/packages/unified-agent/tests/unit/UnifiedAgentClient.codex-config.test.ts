import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const mockCodexConnect = vi.fn();
const mockCodexDisconnect = vi.fn();
const mockCodexEndSession = vi.fn();
const mockCodexResetSession = vi.fn();
const mockCodexLoadSession = vi.fn();
const mockCodexSendMessage = vi.fn();
const mockCodexCancelPrompt = vi.fn();
const mockSetPendingModel = vi.fn();
const mockSetPendingEffort = vi.fn();
const mockRemoveAllListeners = vi.fn();

function createMockCodexConnection(): EventEmitter & Record<string, unknown> {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    connect: mockCodexConnect,
    disconnect: mockCodexDisconnect,
    endSession: mockCodexEndSession,
    resetSession: mockCodexResetSession,
    loadSession: mockCodexLoadSession,
    sendMessage: mockCodexSendMessage,
    cancelPrompt: mockCodexCancelPrompt,
    setPendingModel: mockSetPendingModel,
    setPendingEffort: mockSetPendingEffort,
    removeAllListeners: mockRemoveAllListeners,
    connectionState: 'ready',
    sessionId: 'codex-thread-1',
  });
  return emitter as EventEmitter & Record<string, unknown>;
}

vi.mock('../../src/connection/CodexAppServerConnection.js', () => ({
  CodexAppServerConnection: vi.fn(() => createMockCodexConnection()),
}));

vi.mock('../../src/connection/AcpConnection.js', () => ({
  AcpConnection: vi.fn(),
}));

vi.mock('../../src/detector/CliDetector.js', () => ({
  CliDetector: vi.fn(() => ({
    detectAll: vi.fn().mockResolvedValue([]),
    getPreferred: vi.fn().mockResolvedValue(null),
  })),
}));

const { UnifiedCodexAgentClient } = await import('../../src/client/UnifiedCodexAgentClient.js');
const { CodexAppServerConnection } = await import('../../src/connection/CodexAppServerConnection.js');

describe('UnifiedCodexAgentClient config staging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCodexConnect.mockResolvedValue({ thread: { id: 'codex-thread-1' } });
    mockCodexDisconnect.mockResolvedValue(undefined);
    mockCodexEndSession.mockResolvedValue(undefined);
    mockCodexResetSession.mockResolvedValue({ thread: { id: 'codex-thread-2' } });
    mockCodexLoadSession.mockResolvedValue({ thread: { id: 'codex-thread-9' } });
    mockCodexSendMessage.mockResolvedValue(undefined);
    mockCodexCancelPrompt.mockResolvedValue(undefined);
  });

  it('codex 연결 시 systemPrompt를 developerInstructions로 전달한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '개발자 지침',
      model: 'gpt-5.4',
    });

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_mode="danger-full-access"',
      ],
    }));
    expect(mockCodexConnect).toHaveBeenCalledWith({
      developerInstructions: '개발자 지침',
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(client.getConnectionInfo().protocol).toBe('codex-app-server');
  });

  it('codex MCP 서버 설정은 app-server 시작 -c 인자로 전달한다', async () => {
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
      args: [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_mode="danger-full-access"',
        '-c',
        'mcp_servers.test-math.url="http://127.0.0.1:1234"',
        '-c',
        'mcp_servers.test-math.tool_timeout_sec=180',
      ],
    }));
    expect(mockCodexConnect).toHaveBeenCalledWith({
      developerInstructions: undefined,
      model: undefined,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('configOverrides의 mcp_servers 설정도 MCP ready 대기 대상으로 등록한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      configOverrides: [
        'mcp_servers.pi-tools.url="http://127.0.0.1:54300"',
        'model="gpt-5.4"',
      ],
    });

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      mcpServerNames: ['pi-tools'],
    }));
  });

  it('codex session resume은 thread/resume에 정책과 systemPrompt를 재전달한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      sessionId: 'codex-thread-existing',
      systemPrompt: '재개 지침',
      model: 'gpt-5.4',
    });

    expect(mockCodexConnect).toHaveBeenCalledWith({
      skipThreadStart: true,
      model: 'gpt-5.4',
    });
    expect(mockCodexLoadSession).toHaveBeenCalledWith('codex-thread-existing', {
      cwd: '/workspace',
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: '재개 지침',
      config: undefined,
    });
    expect(client.getCurrentSystemPrompt()).toBe('재개 지침');
  });

  it('setModel/setConfigOption 후 다음 sendMessage에서 pending override를 consume한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
    });

    await client.setModel('gpt-5.4-mini');
    await client.setConfigOption('reasoning_effort', 'high');
    await client.sendMessage('안녕');

    expect(mockSetPendingModel).toHaveBeenCalledWith('gpt-5.4-mini');
    expect(mockSetPendingEffort).toHaveBeenCalledWith('high');
    expect(mockCodexSendMessage).toHaveBeenCalledWith([
      { type: 'text', text: '안녕', text_elements: [] },
    ]);

    await client.sendMessage('다음');
    expect(mockSetPendingModel).toHaveBeenCalledTimes(1);
    expect(mockSetPendingEffort).toHaveBeenCalledTimes(1);
  });

  it('setMode는 Codex pending mode로 저장되고 즉시 ACP 호출하지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
    });

    await client.setMode('yolo');
    await client.sendMessage('모드 반영');

    expect(mockCodexConnect).toHaveBeenCalledTimes(1);
    expect(mockCodexSendMessage).toHaveBeenCalledTimes(1);
  });

  it('resetSession은 초기 mode와 systemPrompt를 thread/start payload로 보존한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      yoloMode: false,
      systemPrompt: '초기 지침',
    });

    await client.resetSession();

    expect(mockCodexResetSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      developerInstructions: '초기 지침',
      config: undefined,
    });
    expect(client.getCurrentSystemPrompt()).toBe('초기 지침');
  });

  it('setMode와 non-turn setConfigOption은 다음 resetSession payload에 반영한다', async () => {
    const client = new UnifiedCodexAgentClient();
    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '리셋 지침',
    });

    await client.setMode('autoEdit');
    await client.setConfigOption('notify', 'false');
    await client.setConfigOption('model_reasoning_summary', 'auto');
    await client.resetSession('/next-workspace');

    expect(mockCodexResetSession).toHaveBeenCalledWith({
      cwd: '/next-workspace',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: '리셋 지침',
      config: {
        notify: 'false',
        model_reasoning_summary: 'auto',
      },
    });
    expect(mockCodexResetSession).not.toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        approvalPolicy: expect.anything(),
        sandbox: expect.anything(),
      }),
    }));
  });

  it('sessionId resume 경로도 fresh thread/start와 동등한 정책과 developerInstructions를 전달한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      sessionId: 'thread-existing',
      systemPrompt: '재개 지침',
      model: 'gpt-5.4',
      yoloMode: false,
    });

    expect(mockCodexConnect).toHaveBeenCalledWith({
      skipThreadStart: true,
      model: 'gpt-5.4',
    });
    expect(mockCodexLoadSession).toHaveBeenCalledWith('thread-existing', {
      cwd: '/workspace',
      developerInstructions: '재개 지침',
      model: 'gpt-5.4',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      config: undefined,
    });
    expect(client.getCurrentSystemPrompt()).toBe('재개 지침');
  });
});
