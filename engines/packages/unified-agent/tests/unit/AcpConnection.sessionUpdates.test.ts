import { describe, expect, it, vi } from 'vitest';
import type { AcpSessionUpdateParams } from '../../src/types/acp.js';
import { AcpConnection } from '../../src/connection/AcpConnection.js';

interface TestableAcpConnection {
  on: (event: 'availableCommandsUpdate', handler: (...args: unknown[]) => void) => TestableAcpConnection;
  processSessionUpdate: (notification: AcpSessionUpdateParams) => void;
  promptKeepAlive: (() => void) | null;
}

describe('AcpConnection session updates', () => {
  it('available_commands_update를 전용 이벤트로 승격한다', () => {
    const connection = createConnection();
    const handler = vi.fn();

    connection.on('availableCommandsUpdate', handler);

    connection.processSessionUpdate({
      sessionId: 'session-gemini',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'create_plan',
            description: '계획을 생성합니다.',
          },
        ],
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      [
        {
          name: 'create_plan',
          description: '계획을 생성합니다.',
        },
      ],
      'session-gemini',
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'create_plan',
            description: '계획을 생성합니다.',
          },
        ],
      },
    );
  });

  it('available_commands_update도 promptKeepAlive를 리셋한다', () => {
    const connection = createConnection();
    const keepAlive = vi.fn();
    connection.promptKeepAlive = keepAlive;

    connection.processSessionUpdate({
      sessionId: 'session-gemini',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'research_codebase',
            description: '코드베이스를 조사합니다.',
          },
        ],
      },
    });

    expect(keepAlive).toHaveBeenCalledTimes(1);
  });

  it('기존 allowlist 밖의 update도 promptKeepAlive를 리셋한다', () => {
    const connection = createConnection();
    const keepAlive = vi.fn();
    connection.promptKeepAlive = keepAlive;

    connection.processSessionUpdate({
      sessionId: 'session-gemini',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [],
      },
    });

    expect(keepAlive).toHaveBeenCalledTimes(1);
  });
});

function createConnection(): TestableAcpConnection {
  return new AcpConnection({
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    cwd: process.cwd(),
  }) as unknown as TestableAcpConnection;
}
