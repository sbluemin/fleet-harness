import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const mockAcpConnect = vi.fn();
const mockAcpSendPrompt = vi.fn();
const mockAcpSetMode = vi.fn();
const mockAcpSetModel = vi.fn();
const mockAcpSetConfigOption = vi.fn();
const originalCodexUseAcp = process.env.CODEX_USE_ACP;
const originalCodexConfig = process.env.CODEX_CONFIG;

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

// ACP 경로용 mock 연결. instanceof AcpConnection이 true가 되도록 prototype을 상속시키고,
// EventEmitter 기반 이벤트 메서드와 connect/sendPrompt 등 사용 메서드를 주입한다.
function createMockAcpConnection(): Record<string, unknown> {
  const emitter = new EventEmitter();
  return Object.assign(Object.create(AcpConnection.prototype), {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeAllListeners: vi.fn(),
    connect: mockAcpConnect,
    sendPrompt: mockAcpSendPrompt,
    setMode: mockAcpSetMode,
    setModel: mockAcpSetModel,
    setConfigOption: mockAcpSetConfigOption,
    disconnect: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    canResetSession: true,
    connectionState: 'ready',
    sessionId: 'acp-session-1',
  });
}

vi.mock('../../src/connection/CodexAppServerConnection.js', () => ({
  CodexAppServerConnection: vi.fn(() => createMockCodexConnection()),
}));

vi.mock('../../src/connection/AcpConnection.js', () => ({
  AcpConnection: vi.fn(() => createMockAcpConnection()),
}));

vi.mock('../../src/detector/CliDetector.js', () => ({
  CliDetector: vi.fn(() => ({
    detectAll: vi.fn().mockResolvedValue([]),
    getPreferred: vi.fn().mockResolvedValue(null),
  })),
}));

const { UnifiedCodexAgentClient } = await import('../../src/client/UnifiedCodexAgentClient.js');
const { CodexAppServerConnection } = await import('../../src/connection/CodexAppServerConnection.js');
const { AcpConnection } = await import('../../src/connection/AcpConnection.js');

type CodexClient = InstanceType<typeof UnifiedCodexAgentClient>;

// 공개 connect()는 CODEX_USE_ACP 기본값(true)으로 항상 ACP 경로를 타므로,
// 레거시 app-server config 스테이징 검증은 내부 connectAppServer 경로를 직접 구동한다.
// (소스 동작은 변경하지 않는 테스트 전용 우회 — element access로 private 메서드 호출)
async function connectAppServer(
  client: CodexClient,
  options: Parameters<CodexClient['connect']>[0],
): Promise<void> {
  await client['connectAppServer'](options);
}

// ACP 연결 생성자에 전달된 첫 호출 인자(env/args)를 추출한다.
function acpCtorOptions(): { env?: Record<string, string | undefined>; args: string[] } {
  const call = vi.mocked(AcpConnection).mock.calls[0];
  return call[0] as unknown as { env?: Record<string, string | undefined>; args: string[] };
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('UnifiedCodexAgentClient config staging', () => {
  beforeEach(() => {
    delete process.env.CODEX_USE_ACP;
    delete process.env.CODEX_CONFIG;
    vi.clearAllMocks();
    mockCodexConnect.mockResolvedValue({ thread: { id: 'codex-thread-1' } });
    mockCodexDisconnect.mockResolvedValue(undefined);
    mockCodexEndSession.mockResolvedValue(undefined);
    mockCodexResetSession.mockResolvedValue({ thread: { id: 'codex-thread-2' } });
    mockCodexLoadSession.mockResolvedValue({ thread: { id: 'codex-thread-9' } });
    mockCodexSendMessage.mockResolvedValue(undefined);
    mockCodexCancelPrompt.mockResolvedValue(undefined);
    mockAcpConnect.mockResolvedValue({ sessionId: 'acp-session-1' });
    mockAcpSendPrompt.mockResolvedValue({ stopReason: 'endTurn' });
    mockAcpSetMode.mockResolvedValue(undefined);
    mockAcpSetModel.mockResolvedValue(undefined);
    mockAcpSetConfigOption.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreEnvironmentVariable('CODEX_USE_ACP', originalCodexUseAcp);
    restoreEnvironmentVariable('CODEX_CONFIG', originalCodexConfig);
  });

  it('CODEX_USE_ACP 미설정 시 ACP로 연결한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({ cwd: '/workspace', cli: 'codex' });

    expect(AcpConnection).toHaveBeenCalledTimes(1);
    expect(CodexAppServerConnection).not.toHaveBeenCalled();
  });

  it("options.env CODEX_USE_ACP='false'는 App Server로 연결한다", async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      env: { CODEX_USE_ACP: 'false' },
    });

    expect(CodexAppServerConnection).toHaveBeenCalledTimes(1);
    expect(AcpConnection).not.toHaveBeenCalled();
  });

  it("options.env CODEX_USE_ACP='0'는 App Server로 연결한다", async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      env: { CODEX_USE_ACP: '0' },
    });

    expect(CodexAppServerConnection).toHaveBeenCalledTimes(1);
    expect(AcpConnection).not.toHaveBeenCalled();
  });

  it("options.env CODEX_USE_ACP='true'는 ACP로 연결한다", async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      env: { CODEX_USE_ACP: 'true' },
    });

    expect(AcpConnection).toHaveBeenCalledTimes(1);
    expect(CodexAppServerConnection).not.toHaveBeenCalled();
  });

  it('options.env가 process.env CODEX_USE_ACP보다 우선한다', async () => {
    process.env.CODEX_USE_ACP = 'false';
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      env: { CODEX_USE_ACP: 'true' },
    });

    expect(AcpConnection).toHaveBeenCalledTimes(1);
    expect(CodexAppServerConnection).not.toHaveBeenCalled();
  });

  it('ACP mode 매핑은 공식 codex-acp bridge mode ID를 사용한다', () => {
    const client = new UnifiedCodexAgentClient();
    const testClient = client as unknown as {
      resolveAcpMode: (modeId: string) => string;
    };

    expect(testClient.resolveAcpMode('default')).toBe('read-only');
    expect(testClient.resolveAcpMode('autoEdit')).toBe('agent');
    expect(testClient.resolveAcpMode('yolo')).toBe('agent-full-access');
  });

  it('지원하지 않는 model+effort 조합은 ACP bridge 생성 전에 로컬 오류로 거부한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await expect(client.connect({
      cwd: '/workspace',
      cli: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'ultra',
    })).rejects.toThrow(
      'codex/gpt-5.6-luna 모델은 effort "ultra"을(를) 지원하지 않습니다. 사용 가능: low, medium, high, xhigh, max',
    );
    expect(AcpConnection).not.toHaveBeenCalled();
  });

  it('ACP resetSession 후 첫 프롬프트는 사용자 content만 전달한다(prepend 없음)', async () => {
    // systemPrompt 주입은 connect 시점 CODEX_CONFIG env가 담당하므로, reconnect 후에도
    // 프롬프트에 지침을 prepend하지 않고 사용자 입력만 그대로 전달해야 한다.
    const client = new UnifiedCodexAgentClient();
    const mockAcpConnection = Object.assign(Object.create(AcpConnection.prototype), {
      canResetSession: true,
      connectionState: 'ready',
      endSession: vi.fn().mockResolvedValue(undefined),
      reconnectSession: vi.fn().mockResolvedValue({ sessionId: 'acp-session-2' }),
      sendPrompt: vi.fn().mockResolvedValue({ stopReason: 'endTurn' }),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      connection: mockAcpConnection,
      sessionId: 'acp-session-1',
      sessionCwd: '/workspace',
      currentSystemPrompt: '리셋 후 지침',
    });

    await client.resetSession();
    await client.sendMessage('첫 요청');
    await client.sendMessage('두 번째 요청');

    expect(mockAcpConnection.endSession).toHaveBeenCalledWith('acp-session-1');
    expect(mockAcpConnection.reconnectSession).toHaveBeenCalledWith('/workspace');
    expect(mockAcpConnection.sendPrompt).toHaveBeenNthCalledWith(1, 'acp-session-2', '첫 요청');
    expect(mockAcpConnection.sendPrompt).toHaveBeenNthCalledWith(2, 'acp-session-2', '두 번째 요청');
    // 리셋 이후에도 snapshot은 보존된다(env 상주).
    expect(client.getCurrentSystemPrompt()).toBe('리셋 후 지침');
  });

  it('ACP 연결은 systemPrompt를 CODEX_CONFIG env로 주입하고 argv에는 넣지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '개발자 지침',
    });

    const options = acpCtorOptions();
    const config = JSON.parse(options.env?.CODEX_CONFIG ?? '{}') as Record<string, unknown>;
    expect(config.developer_instructions).toBe('개발자 지침');
    // argv에는 -c / developer_instructions 흔적이 없어야 한다(argv 주입 폐기).
    expect(options.args).not.toContain('-c');
    expect(options.args.some((arg) => arg.includes('developer_instructions'))).toBe(false);
  });

  it('호출자 제공 CODEX_CONFIG(valid JSON)는 병합되고 developer_instructions는 systemPrompt가 우선한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
      systemPrompt: '우선 지침',
      env: {
        CODEX_CONFIG: JSON.stringify({ model: 'gpt-5.4', developer_instructions: '무시될 지침' }),
      },
    });

    const options = acpCtorOptions();
    const config = JSON.parse(options.env?.CODEX_CONFIG ?? '{}') as Record<string, unknown>;
    expect(config).toEqual({ model: 'gpt-5.4', developer_instructions: '우선 지침' });
  });

  it('systemPrompt·configOverrides·호출자 CODEX_CONFIG가 모두 없으면 env에 CODEX_CONFIG를 넣지 않는다', async () => {
    const client = new UnifiedCodexAgentClient();

    await client.connect({
      cwd: '/workspace',
      cli: 'codex',
    });

    const options = acpCtorOptions();
    expect(options.env?.CODEX_CONFIG).toBeUndefined();
  });

  it('codex 연결 시 systemPrompt를 developerInstructions로 전달한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await connectAppServer(client, {
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

    await connectAppServer(client, {
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

    await connectAppServer(client, {
      cwd: '/workspace',
      cli: 'codex',
      configOverrides: [
        'mcp_servers.fleet-tools.url="http://127.0.0.1:54300"',
        'model="gpt-5.4"',
      ],
    });

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      mcpServerNames: ['fleet-tools'],
    }));
  });

  it('codex session resume은 thread/resume에 정책과 systemPrompt를 재전달한다', async () => {
    const client = new UnifiedCodexAgentClient();

    await connectAppServer(client, {
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
    await connectAppServer(client, {
      cwd: '/workspace',
      cli: 'codex',
    });

    await client.setModel('gpt-5.4-mini');
    // app-server 경로의 turn-level 키는 'effort' (ACP 경로에서만 'reasoning_effort'로 매핑)
    await client.setConfigOption('effort', 'high');
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
    await connectAppServer(client, {
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
    await connectAppServer(client, {
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
    await connectAppServer(client, {
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

    await connectAppServer(client, {
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
