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

  it('PEM private key 블록이 줄 단위로 수신되어도 바디 라인이 diagnosticTail에 누출되지 않는다', () => {
    const connection = new TestConnection();

    connection.push('normal line before\n');
    connection.push('-----BEGIN PRIVATE KEY-----\n');
    connection.push('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n');
    connection.push('-----END PRIVATE KEY-----\n');
    connection.push('normal line after\n');

    const tail = connection.diagnosticTail();

    // PEM 바디가 누출되지 않아야 함
    expect(tail).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC');
    // BEGIN/END/바디 모두 REDACTED 처리
    expect(tail.match(/\[REDACTED:pem_private_key\]/g)?.length).toBe(3);
    // 비밀 외 정상 라인은 유지
    expect(tail).toContain('normal line before');
    expect(tail).toContain('normal line after');
  });

  it('청크 경계로 PEM 블록이 분할 수신되어도 바디가 누출되지 않는다', () => {
    const connection = new TestConnection();

    // BEGIN과 바디가 서로 다른 청크로 도착하는 경우
    connection.push('-----BEGIN EC PRIVATE KEY-----\ntop-secret-key-material\n');
    connection.push('more-secret-material\n-----END EC PRIVATE KEY-----\n');

    const tail = connection.diagnosticTail();

    expect(tail).not.toContain('top-secret-key-material');
    expect(tail).not.toContain('more-secret-material');
    expect(tail).toContain('[REDACTED:pem_private_key]');
  });

  it('withStderrDiagnostics 출력에 PEM 바디가 누출되지 않는다', () => {
    const connection = new TestConnection();

    connection.push('-----BEGIN RSA PRIVATE KEY-----\n');
    connection.push('supersecretprivatekey\n');
    connection.push('-----END RSA PRIVATE KEY-----\n');

    const error = connection.diagnose(new Error('connection failed'), 'ACP session/new');

    expect(error.message).not.toContain('supersecretprivatekey');
    expect(error.message).toContain('[REDACTED:pem_private_key]');
    expect(error.message).toContain('ACP session/new stderr tail:');
  });

  it('PEM 블록 앞뒤의 정상 stderr는 리댁트 없이 보존된다', () => {
    const connection = new TestConnection();

    connection.push('before-pem\n');
    connection.push('-----BEGIN PRIVATE KEY-----\n');
    connection.push('secretbody\n');
    connection.push('-----END PRIVATE KEY-----\n');
    connection.push('after-pem\n');

    const tail = connection.diagnosticTail();

    expect(tail).toContain('before-pem');
    expect(tail).toContain('after-pem');
    expect(tail).not.toContain('secretbody');
  });

  it('CRLF로 수신된 PEM 블록도 바디가 누출되지 않는다', () => {
    const connection = new TestConnection();

    connection.push('-----BEGIN PRIVATE KEY-----\r\n');
    connection.push('crlf-secret-body\r\n');
    connection.push('-----END PRIVATE KEY-----\r\n');

    const tail = connection.diagnosticTail();

    expect(tail).not.toContain('crlf-secret-body');
    expect(tail.match(/\[REDACTED:pem_private_key\]/g)?.length).toBe(3);
  });

  it('환경변수 형식 등 BEGIN 마커가 임베디드된 라인도 PEM 모드로 전환하고 바디가 누출되지 않는다', () => {
    const connection = new TestConnection();

    // "PREFIX=-----BEGIN PRIVATE KEY-----" 형태: 앵커 매치 안 되는 케이스
    connection.push('PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n');
    connection.push('embedded-secret-body\n');
    connection.push('-----END PRIVATE KEY-----\n');

    const tail = connection.diagnosticTail();

    // 바디가 누출되지 않아야 함
    expect(tail).not.toContain('embedded-secret-body');
    // BEGIN이 포함된 라인 전체도 리댁트
    expect(tail).not.toContain('PRIVATE_KEY=');
    expect(tail).toContain('[REDACTED:pem_private_key]');
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
