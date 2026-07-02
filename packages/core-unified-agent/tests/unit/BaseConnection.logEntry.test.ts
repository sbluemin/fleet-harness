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

  diagnosticTail(): string {
    return this.getStderrDiagnosticTail();
  }

  diagnose(error: unknown, phase: string): Error {
    return this.withStderrDiagnostics(error, phase);
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

  it('stderr 진단 tail은 최근 라인만 보존하고 secret을 마스킹한다', () => {
    const connection = new TestConnection();

    for (let index = 0; index < 25; index += 1) {
      connection.push(`stderr-${index} OPENAI_API_KEY=sk-testsecretvalue${String(index).padStart(20, '0')}\n`);
    }

    const tail = connection.diagnosticTail();
    expect(tail).toContain('stderr-24');
    expect(tail).not.toContain('stderr-0');
    expect(tail).toContain('[REDACTED:generic_secret]');
    expect(tail).not.toContain('sk-testsecretvalue');

    const error = connection.diagnose(new Error('session failed'), 'ACP session/new');
    expect(error.message).toContain('session failed');
    expect(error.message).toContain('ACP session/new stderr tail:');
    expect(error.message).toContain('stderr-24');
  });
});
