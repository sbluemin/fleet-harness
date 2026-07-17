import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../src/connection/CodexAppServerConnection.js');

const { createSessionIdentityResolver } = await import('../../src/client/SessionIdentityResolver.js');

describe('SessionIdentityResolver real Codex spawn failure', () => {
  const uncaughtExceptions: Error[] = [];
  const unhandledRejections: unknown[] = [];
  const onUncaughtException = (error: Error) => uncaughtExceptions.push(error);
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);

  afterEach(() => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    uncaughtExceptions.length = 0;
    unhandledRejections.length = 0;
  });

  it('fails closed for an impossible absolute executable without process-level errors', async () => {
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);

    const result = await createSessionIdentityResolver({
      provider: 'codex',
      cwd: process.cwd(),
      command: '/definitely-missing/fleet-codex-identity-reader',
    }).resolve('codex-thread-that-does-not-matter');

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(result).toBeNull();
    expect(uncaughtExceptions).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });
});
