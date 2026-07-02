/**
 * BaseConnection - 프로세스 Spawn + Stream 관리 기반 클래스
 * child_process.spawn으로 CLI를 실행하고, 공식 ACP SDK용 Stream을 생성합니다.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import type { ConnectionState, StructuredLogEntry } from '../types/common.js';
import { isWindows } from '../utils/env.js';
import { killProcess } from '../utils/process.js';

/** BaseConnection 생성 옵션 */
export interface BaseConnectionOptions {
  /** 실행 커맨드 */
  command: string;
  /** 커맨드 인자 */
  args: string[];
  /** 작업 디렉토리 */
  cwd: string;
  /** 환경변수 */
  env?: Record<string, string | undefined>;
  /** 요청 타임아웃 (ms, 기본: 600000) */
  requestTimeout?: number;
  /** 초기화 타임아웃 (ms, 기본: 60000) */
  initTimeout?: number;
  /** 프롬프트 유휴 타임아웃 (ms, 기본: 120000).
   *  스트리밍 활동 없이 이 시간이 경과하면 프롬프트 타임아웃.
   *  0 이하이면 유휴 타임아웃 비활성화. */
  promptIdleTimeout?: number;
}

interface SecretPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const STDERR_DIAGNOSTIC_LINE_LIMIT = 20;
const STDERR_DIAGNOSTIC_LINE_CHAR_LIMIT = 2_000;
const STDERR_DIAGNOSTIC_TOTAL_BYTE_LIMIT = 8_000;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { label: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { label: 'github_token', pattern: /gh[psour]_[A-Za-z0-9]{36}/g },
  { label: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { label: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    label: 'generic_secret',
    pattern: /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"']+["']?/gi,
  },
  {
    label: 'pem_private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

// PEM 블록 헤더/푸터 감지용 패턴 (줄 단위 상태 기계에서 사용)
// 앵커 없이 포함 여부를 검사해 "PREFIX=-----BEGIN PRIVATE KEY-----" 같은 임베디드 마커도 감지
const PEM_BEGIN_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END_PATTERN = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * 프로세스 Spawn + Stream 관리 기반 클래스.
 * child_process.spawn으로 CLI 프로세스를 생성하고,
 * Node.js Stream → Web Streams 변환을 통해 공식 ACP SDK 호환 Stream을 제공합니다.
 */
export class BaseConnection extends EventEmitter {
  protected child: ChildProcess | null = null;
  protected state: ConnectionState = 'disconnected';
  protected acpStream: Stream | null = null;
  protected childExitPromise: Promise<void> | null = null;

  protected readonly command: string;
  protected readonly args: string[];
  protected readonly cwd: string;
  protected readonly env: Record<string, string | undefined>;
  protected readonly requestTimeout: number;
  protected readonly initTimeout: number;
  protected readonly promptIdleTimeout: number;
  protected stderrBuffer = '';
  private readonly diagnosticStderrTail: string[] = [];
  // PEM 블록 내부 여부 추적 (줄 단위 수신 시 바디 라인 누출 방지)
  private inPemBlock = false;

  constructor(options: BaseConnectionOptions) {
    super();
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env ?? { ...process.env };
    this.requestTimeout = options.requestTimeout ?? 600_000; // 10분
    this.initTimeout = options.initTimeout ?? 60_000; // 60초
    this.promptIdleTimeout = options.promptIdleTimeout ?? 600_000; // 10분
  }

  /** 현재 연결 상태 */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * CLI 프로세스를 spawn하고 기본 이벤트 핸들링을 설정합니다.
   * stderr 로그 수집, 프로세스 종료/에러 처리를 포함합니다.
   * ACP ndJsonStream 변환 없이 raw child process만 반환합니다.
   *
   * @returns spawn된 child process
   */
  protected spawnRawProcess(): ChildProcess {
    this.setState('connecting');

    // Windows에서 .cmd 래퍼(npx.cmd 등)를 실행하려면 cmd.exe를 경유해야 합니다.
    // cmd.exe /C 단순 래핑은 경로에 공백이 있을 때(예: C:\Program Files\nodejs\npx.cmd)
    // cmd의 quote-stripping 규칙에 따라 바깥 따옴표가 벗겨져 명령이 공백에서 끊깁니다.
    // 이를 회피하려면 cmd.exe /S /C ""<cmd>" <args>" 관용구와 windowsVerbatimArguments를
    // 함께 사용해 cmd가 바깥쪽 이중 따옴표만 벗기고 내부 인용은 보존하도록 합니다.
    // 또한 cmd는 MSVCRT식 `\"` 이스케이프를 인식하지 않으므로 내부 `"`는 `""`로 이중화합니다.
    const child = isWindows()
      ? spawn(
          (this.env.ComSpec as string) ?? 'cmd.exe',
          buildWindowsCmdArgs(this.command, this.args),
          {
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.env as NodeJS.ProcessEnv,
            windowsVerbatimArguments: true,
            // 콘솔이 없는 호스트(예: fleet-console 백엔드)에서 cmd.exe를 spawn하면
            // Windows가 새 콘솔 창을 할당해 깜빡인다. stdio는 모두 pipe라 가시 콘솔이
            // 불필요하므로 CREATE_NO_WINDOW로 창 생성을 억제한다. (fleet-cli처럼 콘솔이
            // 이미 있는 경우에도 무해하다.)
            windowsHide: true,
          },
        )
      : spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env as NodeJS.ProcessEnv,
          detached: true,
        });

    this.childExitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });

    // stderr 로그 수집
    child.stderr?.on('data', (data: Buffer) => {
      this.consumeStderrChunk(data.toString());
    });

    // 프로세스 종료 처리
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.flushStderrBuffer();
      this.setState('closed');
      this.emit('exit', code, signal);
    });

    // 프로세스 에러 처리
    child.on('error', (err) => {
      this.flushStderrBuffer();
      this.setState('error');
      this.emit('error', err);
    });

    this.child = child;
    return child;
  }

  /**
   * CLI 프로세스를 spawn하고 ACP SDK 호환 Stream을 생성합니다.
   * spawnRawProcess()를 호출한 후 ndJsonStream 변환을 추가합니다.
   *
   * @returns 공식 ACP SDK의 Stream (ndJsonStream)
   */
  protected spawnProcess(): { child: ChildProcess; stream: Stream } {
    const child = this.spawnRawProcess();

    // Node.js Stream → Web Streams 변환
    const webWritable = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const webReadable = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;

    // 공식 ACP SDK의 ndJsonStream으로 변환
    const stream = ndJsonStream(webWritable, webReadable);

    this.acpStream = stream;
    this.setState('connected');

    return { child, stream };
  }

  /**
   * 연결을 닫고 프로세스를 종료합니다.
   */
  async disconnect(): Promise<void> {
    if (this.child) {
      const child = this.child;
      const exitPromise = this.childExitPromise ?? this.createExitPromise(child);

      killProcess(child);
      await this.waitForExit(exitPromise, 5000);

      this.child = null;
      this.childExitPromise = null;
    }
    this.acpStream = null;
    this.setState('disconnected');
  }

  /**
   * 연결 상태를 업데이트하고 이벤트를 발생시킵니다.
   */
  protected setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }

  /** stderr 청크를 줄 단위로 재조립해 legacy/structured 로그를 동시에 발행합니다. */
  protected consumeStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const line = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      this.emitStderrLine(line);
    }
  }

  /** 남은 stderr 버퍼를 강제로 flush합니다. */
  protected flushStderrBuffer(): void {
    if (!this.stderrBuffer) {
      return;
    }

    const remaining = this.stderrBuffer;
    this.stderrBuffer = '';
    this.emitStderrLine(remaining);
  }

  /** stderr 한 줄을 legacy/structured 로그로 동시에 발행합니다. */
  protected emitStderrLine(rawLine: string): void {
    const message = rawLine.trim();
    if (!message) {
      return;
    }

    this.recordDiagnosticStderrLine(message);
    this.emit('log', message);
    this.emit('logEntry', this.createStructuredLogEntry(message));
  }

  /** 실패 메시지에 붙일 수 있는 짧고 마스킹된 stderr tail을 반환합니다. */
  protected getStderrDiagnosticTail(): string {
    return this.diagnosticStderrTail.join('\n');
  }

  /** 원본 에러에 stderr tail 진단을 붙여 상위 계층으로 전달합니다. */
  protected withStderrDiagnostics(error: unknown, phase: string): Error {
    const baseError = error instanceof Error ? error : new Error(String(error));
    this.flushStderrBuffer();
    const stderrTail = this.getStderrDiagnosticTail();
    if (!stderrTail || baseError.message.includes(`${phase} stderr tail:`)) {
      return baseError;
    }

    const diagnosticError = new Error(
      `${baseError.message}\n\n${phase} stderr tail:\n${stderrTail}`,
      { cause: baseError },
    );
    diagnosticError.name = baseError.name;
    return diagnosticError;
  }

  /** 기본 구조화 stderr 로그 항목을 생성합니다. */
  protected createStructuredLogEntry(message: string): StructuredLogEntry {
    return {
      message,
      source: 'stderr',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 이미 종료된 프로세스를 고려해 exit 대기 Promise를 생성합니다.
   */
  private createExitPromise(child: ChildProcess): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
  }

  /**
   * 프로세스 종료를 지정 시간까지 대기합니다.
   */
  private async waitForExit(
    exitPromise: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    if (timeoutMs <= 0) {
      await exitPromise;
      return;
    }

    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  private recordDiagnosticStderrLine(message: string): void {
    const pemMarkerLine = normalizePemMarkerLine(message);

    // PEM BEGIN 마커: 이후 모든 라인(바디·END 포함)을 비밀로 처리
    if (PEM_BEGIN_PATTERN.test(pemMarkerLine)) {
      this.inPemBlock = true;
    }

    const inBlock = this.inPemBlock;

    // PEM END 마커: 현재 라인까지 비밀 처리 후 블록 종료
    if (PEM_END_PATTERN.test(pemMarkerLine)) {
      this.inPemBlock = false;
    }

    const sanitized = sanitizeDiagnosticStderrLine(message, inBlock);
    if (!sanitized) {
      return;
    }

    this.diagnosticStderrTail.push(sanitized);
    while (this.diagnosticStderrTail.length > STDERR_DIAGNOSTIC_LINE_LIMIT) {
      this.diagnosticStderrTail.shift();
    }
    while (
      byteLength(this.getStderrDiagnosticTail()) > STDERR_DIAGNOSTIC_TOTAL_BYTE_LIMIT &&
      this.diagnosticStderrTail.length > 1
    ) {
      this.diagnosticStderrTail.shift();
    }
  }
}

/**
 * 단일 토큰을 cmd.exe의 인용 규칙에 맞게 감쌉니다.
 * 공백, `"`, cmd-특수문자(`& < > ( ) @ ^ |`)를 포함하면 외곽을 `"..."`로 감싸고
 * 내부의 `"`는 `""`로 이중화하여 cmd 내부에서 리터럴로 보존되게 합니다.
 * 빈 문자열은 `""`로 반환해 인자 소실을 방지합니다.
 */
function quoteForCmd(token: string): string {
  if (token === '') {
    return '""';
  }
  if (!/[\s"&<>()@^|]/.test(token)) {
    return token;
  }
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * `cmd.exe /S /C ""<cmd>" <args>"` 호출에 필요한 args 배열을 생성합니다.
 * `/S`는 cmd의 첫/마지막 따옴표 제거 예외 규칙을 끄고, 외곽 이중 따옴표를
 * 벗긴 뒤 내부 인용은 그대로 보존하게 합니다. spawn 호출 시
 * windowsVerbatimArguments: true 와 함께 사용해야 Node가 자동 이스케이프로
 * 구성을 깨뜨리지 않습니다.
 */
function buildWindowsCmdArgs(command: string, args: string[]): string[] {
  const line = [command, ...args].map(quoteForCmd).join(' ');
  return ['/S', '/C', `"${line}"`];
}

function sanitizeDiagnosticStderrLine(value: string, isPemLine: boolean): string {
  // PEM 블록 라인은 ANSI 제거·시크릿 스캔 없이 즉시 리댁트
  const cleaned = (
    isPemLine
      ? '[REDACTED:pem_private_key]'
      : redactDiagnosticSecrets(value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, ''))
  ).trim();
  if (cleaned.length <= STDERR_DIAGNOSTIC_LINE_CHAR_LIMIT) {
    return cleaned;
  }
  const omitted = cleaned.length - STDERR_DIAGNOSTIC_LINE_CHAR_LIMIT;
  return `${cleaned.slice(0, STDERR_DIAGNOSTIC_LINE_CHAR_LIMIT)} [truncated ${omitted} chars]`;
}

function normalizePemMarkerLine(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').trim();
}

function redactDiagnosticSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { label, pattern }) => text.replace(pattern, `[REDACTED:${label}]`),
    value,
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
