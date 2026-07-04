import { describe, expect, it } from 'vitest';

import { UnifiedCursorAgentClient } from '../../src/client/UnifiedCursorAgentClient.js';
import type { ConnectResult } from '../../src/client/IUnifiedAgentClient.js';
import type { UnifiedClientOptions } from '../../src/types/config.js';

interface CursorClientInternals {
  connection: object | null;
  sessionId: string | null;
  currentConnectOptions: UnifiedClientOptions | null;
}

describe('UnifiedCursorAgentClient', () => {
  it('setModel은 기존 연결 옵션을 보존하고 새 모델로 재연결한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedOptions: UnifiedClientOptions[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'max',
      sessionId: 'old-session',
      systemPrompt: '시스템 지침',
      env: { CURSOR_TEST_ENV: '1' },
      clientInfo: { name: 'unit-test', version: '1.0.0' },
      timeout: 1234,
      promptIdleTimeout: 5678,
      autoApprove: true,
      mcpServers: [
        {
          type: 'http',
          name: 'tools',
          url: 'http://127.0.0.1:9999/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer test' }],
        },
      ],
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      capturedOptions.push(options);
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setModel('gemini-3-flash');

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toMatchObject({
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'gemini-3-flash',
      systemPrompt: '시스템 지침',
      env: { CURSOR_TEST_ENV: '1' },
      clientInfo: { name: 'unit-test', version: '1.0.0' },
      timeout: 1234,
      promptIdleTimeout: 5678,
      autoApprove: true,
    });
    expect(capturedOptions[0]?.effort).toBeUndefined();
    expect(capturedOptions[0]?.sessionId).toBeUndefined();
    expect(capturedOptions[0]?.mcpServers).toEqual(internals.currentConnectOptions.mcpServers);
  });

  it('setModel은 새 effort 모델에 유효한 기존 effort를 보존한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedOptions: UnifiedClientOptions[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'gemini-3-flash',
      effort: 'high',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      capturedOptions.push(options);
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setModel('glm-5.2');

    expect(capturedOptions[0]).toMatchObject({
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'high',
    });
  });

  it('setModel은 새 effort 모델에서 부적합한 기존 effort를 기본값으로 보정한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedOptions: UnifiedClientOptions[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'gemini-3-flash',
      effort: 'invalid',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      capturedOptions.push(options);
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setModel('glm-5.2');

    expect(capturedOptions[0]).toMatchObject({
      model: 'glm-5.2',
      effort: 'max',
    });
  });

  it('setConfigOption("model")도 no-op 대신 재연결 모델 전환을 사용한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedModels: string[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'kimi-k2.7-code',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      if (options.model) {
        capturedModels.push(options.model);
      }
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('model', 'gemini-3-flash');

    expect(capturedModels).toEqual(['gemini-3-flash']);
  });

  it('setConfigOption("model")은 Composer 2.5 모델로 재연결한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedModels: string[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'auto',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      if (options.model) {
        capturedModels.push(options.model);
      }
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('model', 'composer-2.5');

    expect(capturedModels).toEqual(['composer-2.5']);
  });

  it('setConfigOption("effort")는 현재 모델을 보존하고 새 effort로 재연결한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedOptions: UnifiedClientOptions[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'max',
      sessionId: 'old-session',
      systemPrompt: '시스템 지침',
      env: { CURSOR_TEST_ENV: '1' },
      timeout: 1234,
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      capturedOptions.push(options);
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('effort', 'high');

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toMatchObject({
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'high',
      systemPrompt: '시스템 지침',
      env: { CURSOR_TEST_ENV: '1' },
      timeout: 1234,
    });
    expect(capturedOptions[0]?.sessionId).toBeUndefined();
  });

  it('setConfigOption("effort")는 동일 effort이면 재연결하지 않는다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    let connectCalls = 0;

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'high',
    };

    client.connect = async (): Promise<ConnectResult> => {
      connectCalls += 1;
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('effort', 'high');

    expect(connectCalls).toBe(0);
  });

  it('setConfigOption("effort")는 template 없는 모델이면 재연결하지 않는다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    let connectCalls = 0;

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'gemini-3-flash',
    };

    client.connect = async (): Promise<ConnectResult> => {
      connectCalls += 1;
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('effort', 'high');

    expect(connectCalls).toBe(0);
  });

  it('setConfigOption("reasoning_effort")도 effort 재연결 경로를 사용한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedEfforts: string[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'high',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      if (options.effort) {
        capturedEfforts.push(options.effort);
      }
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'new-session' },
      };
    };

    await client.setConfigOption('reasoning_effort', 'max');

    expect(capturedEfforts).toEqual(['max']);
  });

  it('setModel reconnect 실패 시 이전 연결 옵션으로 복구를 시도한다', async () => {
    const client = new UnifiedCursorAgentClient();
    const internals = client as unknown as CursorClientInternals;
    const capturedOptions: UnifiedClientOptions[] = [];

    internals.connection = {};
    internals.sessionId = 'old-session';
    internals.currentConnectOptions = {
      cli: 'cursor',
      cwd: '/tmp/workspace',
      model: 'glm-5.2',
      effort: 'high',
    };

    client.connect = async (options: UnifiedClientOptions): Promise<ConnectResult> => {
      capturedOptions.push(options);
      if (options.model === 'gemini-3-flash') {
        throw new Error('spawn failed');
      }
      return {
        cli: 'cursor',
        protocol: 'acp',
        session: { sessionId: 'restored-session' },
      };
    };

    await expect(client.setModel('gemini-3-flash')).rejects.toThrow(
      '[cursor] 모델 변경 실패로 이전 연결을 복구했습니다. 모델 변경 오류: spawn failed',
    );

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[0]).toMatchObject({ model: 'gemini-3-flash' });
    expect(capturedOptions[1]).toMatchObject({
      model: 'glm-5.2',
      effort: 'high',
    });
  });
});
