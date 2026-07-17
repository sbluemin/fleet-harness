import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionInfo: vi.fn(),
  connection: null as any,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: mocks.getSessionInfo,
}));

vi.mock('../../src/connection/CodexAppServerConnection.js', () => ({
  CodexAppServerConnection: vi.fn(() => mocks.connection),
}));

const { createSessionIdentityResolver } = await import('../../src/client/SessionIdentityResolver.js');
const { CodexAppServerConnection } = await import('../../src/connection/CodexAppServerConnection.js');

describe('SessionIdentityResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection = Object.assign(new EventEmitter(), {
      connect: vi.fn().mockResolvedValue(undefined),
      readThread: vi.fn().mockResolvedValue({ thread: { id: 'codex-1', name: '  Codex title  ' } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses Claude customTitle before summary and passes cwd to the official SDK', async () => {
    mocks.getSessionInfo.mockResolvedValue({
      customTitle: '  User-set title  ',
      summary: 'Summary',
      firstPrompt: 'Prompt',
    });

    await expect(createSessionIdentityResolver({ provider: 'claude', cwd: '/work' }).resolve('claude-1'))
      .resolves.toBe('User-set title');
    expect(mocks.getSessionInfo).toHaveBeenCalledWith('claude-1', { dir: '/work' });
  });

  it('rejects Claude summary when its normalized form is the first prompt', async () => {
    mocks.getSessionInfo.mockResolvedValue({
      summary: '  same   prompt ',
      firstPrompt: 'same prompt',
    });

    await expect(createSessionIdentityResolver({ provider: 'claude', cwd: '/work' }).resolve('claude-1'))
      .resolves.toBeNull();
  });

  it('returns null for malformed or empty Claude metadata', async () => {
    mocks.getSessionInfo.mockResolvedValue({ summary: '   ', firstPrompt: 'Prompt' });
    await expect(createSessionIdentityResolver({ provider: 'claude', cwd: '/work' }).resolve('claude-1'))
      .resolves.toBeNull();
    mocks.getSessionInfo.mockResolvedValue(undefined);
    await expect(createSessionIdentityResolver({ provider: 'claude', cwd: '/work' }).resolve('claude-2'))
      .resolves.toBeNull();
  });

  it('preserves the resolved Codex executable and prefix before app-server arguments', async () => {
    const resolver = createSessionIdentityResolver({
      provider: 'codex',
      cwd: '/work',
      command: '/profiles/team/bin/codex',
      commandPrefixArgs: ['--profile', 'team'],
    });

    await expect(resolver.resolve('codex-1')).resolves.toBe('Codex title');
    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      command: '/profiles/team/bin/codex',
      args: ['--profile', 'team', 'app-server', '--listen', 'stdio://'],
      cwd: '/work',
    }));
    expect(mocks.connection?.connect).toHaveBeenCalledWith({ skipThreadStart: true });
    expect(mocks.connection?.readThread).toHaveBeenCalledWith('codex-1');
    expect(mocks.connection?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('selects the provider once and never re-branches while resolving', async () => {
    const options = { provider: 'codex' as const, cwd: '/work' };
    const resolver = createSessionIdentityResolver(options);
    (options as { provider: 'claude' | 'codex' }).provider = 'claude';

    await expect(resolver.resolve('codex-1')).resolves.toBe('Codex title');
    expect(mocks.getSessionInfo).not.toHaveBeenCalled();
    expect(mocks.connection?.readThread).toHaveBeenCalledWith('codex-1');
  });

  it('retains explicit complete args for isolated callers', async () => {
    await createSessionIdentityResolver({
      provider: 'codex',
      cwd: '/work',
      commandPrefixArgs: ['--ignored-prefix'],
      args: ['app-server', '--test-stdio'],
    }).resolve('codex-1');

    expect(CodexAppServerConnection).toHaveBeenCalledWith(expect.objectContaining({
      args: ['app-server', '--test-stdio'],
    }));
  });

  it('explicitly ignores a Codex preview without a name', async () => {
    mocks.connection?.readThread.mockResolvedValue({
      thread: { id: 'codex-1', preview: 'Preview must not become a title' },
    });

    await expect(createSessionIdentityResolver({ provider: 'codex', cwd: '/work' }).resolve('codex-1'))
      .resolves.toBeNull();
  });

  it('fails closed and cleans up when the resolved Codex executable is missing', async () => {
    mocks.connection.connect.mockRejectedValue(new Error('spawn ENOENT'));

    await expect(createSessionIdentityResolver({ provider: 'codex', cwd: '/work' }).resolve('codex-1'))
      .resolves.toBeNull();
    expect(mocks.connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles emitted Codex app-server errors without an uncaught EventEmitter exception', async () => {
    mocks.connection.readThread.mockImplementation(() => new Promise(() => {}));
    const result = createSessionIdentityResolver({ provider: 'codex', cwd: '/work' }).resolve('codex-1');
    await vi.waitFor(() => expect(mocks.connection.connect).toHaveBeenCalled());

    expect(() => mocks.connection.emit('error', new Error('app-server unavailable'))).not.toThrow();
    await expect(result).resolves.toBeNull();
    expect(mocks.connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('times out, starts Codex cleanup, and absorbs late completion failures', async () => {
    vi.useFakeTimers();
    mocks.connection?.readThread.mockImplementation(() => new Promise(() => {}));
    const result = createSessionIdentityResolver({ provider: 'codex', cwd: '/work' }).resolve('codex-1');

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBeNull();
    expect(() => mocks.connection.emit('error', new Error('late termination error'))).not.toThrow();
    expect(mocks.connection?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('is available from the package root export', async () => {
    const root = await import('../../src/index.js');
    expect(root.createSessionIdentityResolver).toBe(createSessionIdentityResolver);
  });
});
