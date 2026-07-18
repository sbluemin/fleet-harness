import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const acpConnections: unknown[] = [];

function createMockConnection(): EventEmitter & Record<string, unknown> {
  return Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    canResetSession: false,
    connectionState: 'ready',
  }) as unknown as EventEmitter & Record<string, unknown>;
}

vi.mock('../../src/connection/AcpConnection.js', () => ({
  AcpConnection: vi.fn((options: unknown) => {
    acpConnections.push(options);
    return createMockConnection();
  }),
}));

const {
  UnifiedClaudeAgentClient,
} = await import('../../src/client/UnifiedClaudeAgentClient.js');
const {
  UnifiedCodexAgentClient,
} = await import('../../src/client/UnifiedCodexAgentClient.js');
const {
  UnifiedCursorAgentClient,
} = await import('../../src/client/UnifiedCursorAgentClient.js');
const {
  UnifiedOpenCodeAgentClient,
} = await import('../../src/client/UnifiedOpenCodeAgentClient.js');

describe('ACP client hostFileAccess propagation', () => {
  it.each([
    ['Claude', () => new UnifiedClaudeAgentClient(), { cli: 'claude' }],
    ['Codex ACP', () => new UnifiedCodexAgentClient(), { cli: 'codex', env: { CODEX_USE_ACP: 'true' } }],
    ['Cursor', () => new UnifiedCursorAgentClient(), { cli: 'cursor' }],
    ['OpenCode', () => new UnifiedOpenCodeAgentClient('opencode-go'), { cli: 'opencode-go' }],
  ] as const)('%s forwards deny to AcpConnection', async (_provider, createClient, providerOptions) => {
    acpConnections.length = 0;
    const client = createClient();

    await client.connect({ cwd: '/workspace', hostFileAccess: 'deny', ...providerOptions });

    expect(acpConnections).toHaveLength(1);
    expect(acpConnections[0]).toEqual(expect.objectContaining({ hostFileAccess: 'deny' }));
  });
});
