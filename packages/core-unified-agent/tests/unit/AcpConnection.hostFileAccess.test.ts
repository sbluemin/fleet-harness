import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockInitialize = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: class {
    closed = new Promise<void>(() => {});

    constructor(createClient: (agent: unknown) => unknown, _stream: unknown) {
      createClient({ initialize: mockInitialize });
    }
  },
}));

const { AcpConnection } = await import('../../src/connection/AcpConnection.js');

type ClientHandler = {
  readTextFile: (params: { path: string }) => Promise<{ content: string }>;
  writeTextFile: (params: { path: string; content: string }) => Promise<object>;
};

type TestableAcpConnection = {
  createClientHandler: () => ClientHandler;
  performInitialize: (stream: unknown) => Promise<void>;
};

function createConnection(hostFileAccess?: 'allow' | 'deny'): TestableAcpConnection {
  return new AcpConnection({
    command: 'test-cli',
    args: ['--acp'],
    cwd: process.cwd(),
    hostFileAccess,
  }) as unknown as TestableAcpConnection;
}

describe('AcpConnection hostFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue({ agentCapabilities: {} });
  });

  it('defaults to allow and retains host file I/O', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('allowed');
    const handler = createConnection().createClientHandler();

    await expect(handler.readTextFile({ path: '/workspace/allowed.txt' })).resolves.toEqual({ content: 'allowed' });
    await handler.writeTextFile({ path: '/workspace/output.txt', content: 'written' });

    expect(mockAccess).toHaveBeenCalledWith('/workspace/allowed.txt');
    expect(mockReadFile).toHaveBeenCalledWith('/workspace/allowed.txt', 'utf-8');
    expect(mockMkdir).toHaveBeenCalledWith('/workspace', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith('/workspace/output.txt', 'written', 'utf-8');
  });

  it('advertises no filesystem capabilities when denied', async () => {
    await createConnection('deny').performInitialize({});

    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({
      clientCapabilities: expect.objectContaining({
        fs: { readTextFile: false, writeTextFile: false },
      }),
    }));
  });

  it('denies reads without touching the host filesystem', async () => {
    const handler = createConnection('deny').createClientHandler();

    await expect(handler.readTextFile({ path: '/secret/path.txt' })).resolves.toEqual({ content: '' });

    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('rejects writes before any host filesystem operation', async () => {
    const handler = createConnection('deny').createClientHandler();

    await expect(handler.writeTextFile({ path: '/secret/path.txt', content: 'secret' }))
      .rejects.toThrow('Host file access is denied');

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
