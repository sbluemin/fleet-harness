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

  describe('tool_call_update NaN 새니타이즈', () => {
    it('title의 NaN 범위 표기를 제거한다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCallUpdate', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          title: 'Read AcpConnection.ts (159,260 - NaN)',
          content: [],
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [emittedTitle, , , payload] = handler.mock.calls[0] as [string, string, string, Record<string, unknown>];
      expect(emittedTitle).toBe('Read AcpConnection.ts');
      expect(payload['title']).toBe('Read AcpConnection.ts');
      expect(payload['content']).toEqual([]);
    });

    it('undefined 범위 표기도 title에서 제거한다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCallUpdate', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          title: 'Read file.ts (undefined, 456)',
        },
      } as unknown as AcpSessionUpdateParams);

      const [emittedTitle] = handler.mock.calls[0] as [string];
      expect(emittedTitle).toBe('Read file.ts');
    });

    it('정상 페이로드는 무손실 통과한다', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCallUpdate', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-3',
          title: 'Read AcpConnection.ts (159, 260)',
          content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [emittedTitle, , , payload] = handler.mock.calls[0] as [string, string, string, Record<string, unknown>];
      expect(emittedTitle).toBe('Read AcpConnection.ts (159, 260)');
      expect(Array.isArray(payload['content'])).toBe(true);
      expect((payload['content'] as unknown[]).length).toBe(1);
      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('title 부재 시 emit 페이로드도 title 키를 가지지 않는다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCallUpdate', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-4',
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [, , , payload] = handler.mock.calls[0] as [string, string, string, Record<string, unknown>];
      expect('title' in payload).toBe(false);
    });
  });

  describe('tool_call NaN 새니타이즈', () => {
    it('title의 NaN 범위 표기를 제거한다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCall', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-a',
          title: 'Read AcpConnection.ts (159,260 - NaN)',
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [emittedTitle, , , payload] = handler.mock.calls[0] as [string, string, string, Record<string, unknown>];
      expect(emittedTitle).toBe('Read AcpConnection.ts');
      expect(payload['title']).toBe('Read AcpConnection.ts');
    });

    it('undefined 범위 표기도 title에서 제거한다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCall', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-b',
          title: 'Read file.ts (undefined, 456)',
        },
      } as unknown as AcpSessionUpdateParams);

      const [emittedTitle] = handler.mock.calls[0] as [string];
      expect(emittedTitle).toBe('Read file.ts');
    });

    it('정상 페이로드는 무손실 통과한다', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCall', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-c',
          title: 'Read AcpConnection.ts (159, 260)',
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [emittedTitle] = handler.mock.calls[0] as [string];
      expect(emittedTitle).toBe('Read AcpConnection.ts (159, 260)');
      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('title 부재 시 emit 페이로드도 title 키를 가지지 않는다', () => {
      const connection = createConnection();
      const handler = vi.fn();
      (connection as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
        .on('toolCall', handler);

      connection.processSessionUpdate({
        sessionId: 'session-codex',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-d',
        },
      } as unknown as AcpSessionUpdateParams);

      expect(handler).toHaveBeenCalledTimes(1);
      const [, , , payload] = handler.mock.calls[0] as [string, string, string, Record<string, unknown>];
      expect('title' in payload).toBe(false);
    });
  });
});

function createConnection(): TestableAcpConnection {
  return new AcpConnection({
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    cwd: process.cwd(),
  }) as unknown as TestableAcpConnection;
}
