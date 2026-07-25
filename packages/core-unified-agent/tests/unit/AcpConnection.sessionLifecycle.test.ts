import { describe, expect, it, vi } from 'vitest';
import { AcpConnection } from '../../src/connection/AcpConnection.js';
import type { Agent, NewSessionResponse, LoadSessionResponse } from '@agentclientprotocol/sdk';

/** private 멤버 접근을 위한 테스트 전용 타입 */
interface TestableAcpConnection {
  agentProxy: Agent | null;
  agentCapabilities: { sessionCapabilities?: { close?: unknown }; loadSession?: boolean } | null;
  command: string;
  connectionState: string;
  createSession: (workspace: string, sessionId?: string) => Promise<NewSessionResponse>;
  endSession: (sessionId: string) => Promise<void>;
  pushStderr: (chunk: string) => void;
  reconnectSession: (cwd: string, sessionId?: string) => Promise<NewSessionResponse>;
  setModel: (sessionId: string, model: string) => Promise<void>;
}

class TestAcpConnection extends AcpConnection {
  pushStderr(chunk: string): void {
    this.consumeStderrChunk(chunk);
  }
}

function createConnection(): TestableAcpConnection {
  return new TestAcpConnection({
    command: 'test-cli',
    args: ['--acp'],
    cwd: process.cwd(),
  }) as unknown as TestableAcpConnection;
}

function createMockAgent(overrides?: Partial<Agent>): Agent {
  return {
    initialize: vi.fn().mockResolvedValue({ agentCapabilities: {} }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'new-session-1' } as NewSessionResponse),
    loadSession: vi.fn().mockResolvedValue({ sessionId: 'loaded-1' } as LoadSessionResponse),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'endTurn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue({}),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Agent;
}

// ─── stderr diagnostics ──────────────────────────────────

describe('AcpConnection stderr diagnostics', () => {
  it('session/new 실패 메시지에 stderr tail을 포함한다', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent({
      newSession: vi.fn().mockRejectedValue(new Error('new session failed')),
    } as unknown as Partial<Agent>);
    conn.agentProxy = mockAgent;

    conn.pushStderr('claude-agent-acp: workspace must be a git repository\n');

    await expect(conn.createSession('/workspace')).rejects.toThrow(
      /new session failed[\s\S]+ACP session\/new stderr tail:[\s\S]+claude-agent-acp: workspace must be a git repository/,
    );
  });
});

describe('AcpConnection Claude session metadata', () => {
  it('ignores the legacy systemPrompt argument instead of emitting _meta.systemPrompt', async () => {
    const conn = new TestAcpConnection({
      command: 'claude',
      args: ['--acp'],
      cliType: 'claude',
      cwd: process.cwd(),
    }) as unknown as TestableAcpConnection;
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;

    await (conn as unknown as {
      createSession: (workspace: string, sessionId?: string, mcpServers?: unknown[], systemPrompt?: string) => Promise<NewSessionResponse>;
    }).createSession('/workspace', undefined, [], 'Tier-2 지침');

    expect(mockAgent.newSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      mcpServers: [],
    });
  });
});

// ─── endSession ───────────────────────────────────────────

describe('AcpConnection.endSession()', () => {
  it('close capability 있으면 closeSession 호출', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = {
      sessionCapabilities: { close: {} },
    };

    await conn.endSession('session-1');

    expect(mockAgent.closeSession).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('close capability 없으면 closeSession 호출 안 함', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = {};

    await conn.endSession('session-1');

    expect(mockAgent.closeSession).not.toHaveBeenCalled();
  });

  it('agentCapabilities가 null이면 closeSession 호출 안 함', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = null;

    await conn.endSession('session-1');

    expect(mockAgent.closeSession).not.toHaveBeenCalled();
  });

  it('closeSession 에러 시에도 실패 무시 (throw 안 함)', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent({
      closeSession: vi.fn().mockRejectedValue(new Error('method not found')),
    } as unknown as Partial<Agent>);
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = {
      sessionCapabilities: { close: {} },
    };

    // throw하지 않아야 함
    await expect(conn.endSession('session-1')).resolves.toBeUndefined();
  });
});

// ─── reconnectSession ─────────────────────────────────────

describe('AcpConnection.reconnectSession()', () => {
  it('sessionId 없으면 newSession() 호출', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    // canResetSession = true 조건: sessionCapabilities.close 있어야 함
    conn.agentCapabilities = { sessionCapabilities: { close: {} } };

    const result = await conn.reconnectSession('/workspace');

    expect(mockAgent.newSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      mcpServers: [],
    });
    expect(result.sessionId).toBe('new-session-1');
  });

  it('sessionId 있고 loadSession 지원 시 loadSession() 호출', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = { loadSession: true };

    const result = await conn.reconnectSession('/workspace', 'existing-session');

    expect(mockAgent.loadSession).toHaveBeenCalledWith({
      sessionId: 'existing-session',
      cwd: '/workspace',
      mcpServers: [],
    });
    expect(result.sessionId).toBe('existing-session');
  });

  it('session/load 실패 시 session/new로 대체하지 않는다', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent({
      loadSession: vi.fn().mockRejectedValue(new Error('missing session')),
    } as unknown as Partial<Agent>);
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = { loadSession: true };

    await expect(conn.reconnectSession('/workspace', 'existing-session')).rejects.toThrow('missing session');
    expect(mockAgent.newSession).not.toHaveBeenCalled();
  });

  it('sessionId 있고 loadSession 미지원 시 에러 throw (E3 fail-fast)', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = { loadSession: false };

    await expect(
      conn.reconnectSession('/workspace', 'existing-session'),
    ).rejects.toThrow('[test-cli] loadSession을 지원하지 않습니다 (E3)');
  });

  it('agentCapabilities에 loadSession 키 없으면 에러 throw (E3)', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = {};

    await expect(
      conn.reconnectSession('/workspace', 'existing-session'),
    ).rejects.toThrow('(E3)');
  });

  it('initialize() 재호출 안 함', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = { sessionCapabilities: { close: {} } };

    await conn.reconnectSession('/workspace');

    expect(mockAgent.initialize).not.toHaveBeenCalled();
  });

  it('canResetSession=false이면 newSession 없이 에러 throw', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = {}; // close capability 없음

    await expect(conn.reconnectSession('/workspace')).rejects.toThrow('session/close 미지원');
    expect(mockAgent.newSession).not.toHaveBeenCalled();
  });

  it('성공 후 state가 ready로 전환됨', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;
    conn.agentCapabilities = { sessionCapabilities: { close: {} } };

    await conn.reconnectSession('/workspace');

    expect(conn.connectionState).toBe('ready');
  });
});

// ─── setModel ─────────────────────────────────────────────

describe('AcpConnection.setModel()', () => {
  it('표준 session/set_config_option model config를 호출한다', async () => {
    const conn = createConnection();
    const mockAgent = createMockAgent();
    conn.agentProxy = mockAgent;

    await conn.setModel('session-1', 'gpt-5.6-sol');

    expect(mockAgent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'model',
      value: 'gpt-5.6-sol',
    });
  });
});
