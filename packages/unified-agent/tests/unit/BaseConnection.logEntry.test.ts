import { describe, expect, it } from 'vitest';

import { BaseConnection } from '../../src/connection/BaseConnection.js';
import type { StructuredLogEntry } from '../../src/types/common.js';

class TestConnection extends BaseConnection {
  constructor() {
    super({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
  }

  push(chunk: string): void {
    this.consumeStderrChunk(chunk);
  }

  flush(): void {
    this.flushStderrBuffer();
  }
}

describe('BaseConnection logEntry', () => {
  it('chunk 경계로 끊긴 stderr를 line 단위로 재조립한다', () => {
    const connection = new TestConnection();
    const logs: string[] = [];
    const entries: StructuredLogEntry[] = [];

    connection.on('log', (message) => {
      logs.push(message);
    });
    connection.on('logEntry', (entry) => {
      entries.push(entry);
    });

    connection.push('first line\nsecond');
    connection.push(' line\nthird line');
    connection.flush();

    expect(logs).toEqual(['first line', 'second line', 'third line']);
    expect(entries.map((entry) => entry.message)).toEqual(['first line', 'second line', 'third line']);
    expect(entries.every((entry) => entry.source === 'stderr')).toBe(true);
  });
});
