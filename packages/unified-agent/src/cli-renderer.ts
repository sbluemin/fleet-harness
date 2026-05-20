/**
 * CLI 렌더러 — Claude Code 스타일 출력
 * ⏺ 인디케이터, ⎿ 도구 결과, 들여쓰기, 줄 접기를 지원합니다.
 */

import type { AcpToolCall, AcpToolCallUpdate, AcpToolCallContent } from './types/acp.js';

/** 추적 중인 도구 호출 */
interface TrackedToolCall {
  title: string;
  toolCallId: string;
}

/** 색상 함수 인터페이스 (picocolors 호환) */
export interface ColorFns {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
}

/** CliRenderer 생성 옵션 */
export interface CliRendererOptions {
  /** stdout 색상 함수 */
  color: ColorFns;
  /** stderr 색상 함수 */
  colorErr: ColorFns;
}

/** 도구 결과 줄 접기 시 최대 표시 줄 수 */
const MAX_RESULT_LINES = 4;

/**
 * Claude Code 스타일 CLI 출력 렌더러.
 *
 * 상태 머신:
 * idle ──messageChunk──▶ streaming
 * idle ──toolCall──────▶ tool_pending
 * streaming ──toolCall──▶ tool_pending
 * tool_pending ──toolCallUpdate(completed/failed)──▶ idle
 * any ──error──▶ idle
 */
export class CliRenderer {
  private phase: 'idle' | 'streaming' | 'thinking' | 'tool_pending' = 'idle';
  private isFirstChunk = true;
  private pendingToolCalls = new Map<string, TrackedToolCall>();
  private readonly ce: ColorFns;

  constructor(options: CliRendererOptions) {
    this.ce = options.colorErr;
  }

  /** 초기 헤더 출력: ⏺ unified-agent (cli) */
  renderHeader(cliLabel: string, resumeLabel: string): void {
    process.stderr.write(
      `${this.ce.bold(this.ce.cyan('⏺'))} ${this.ce.bold('unified-agent')} ${this.ce.dim(`(${cliLabel}${resumeLabel})`)}\n\n`,
    );
  }

  /** 자동 감지 결과 표시 */
  renderAutoDetected(cliName: string): void {
    process.stderr.write(`${this.ce.dim(`  → ${cliName} 연결됨`)}\n\n`);
  }

  /** AI 응답 텍스트 청크 렌더링 */
  renderMessageChunk(text: string): void {
    // 이전 블록(도구/사고)과 분리
    if (this.phase === 'tool_pending' || this.phase === 'thinking') {
      process.stderr.write('\n');
      this.isFirstChunk = true;
    }

    if (this.isFirstChunk) {
      // 첫 청크: 앞쪽 빈 줄(leading newlines) 제거 후 실제 텍스트가 있을 때만 ⏺ 출력
      // Claude API가 \n\n텍스트 형태로 첫 청크를 전송하는 경우 대비
      const trimmed = text.replace(/^\n+/, '');
      if (!trimmed) {
        // 아직 실제 텍스트 없음 — ⏺ 출력 보류
        this.phase = 'streaming';
        return;
      }
      process.stdout.write(`⏺ `);
      this.isFirstChunk = false;
      // 줄바꿈마다 2칸 들여쓰기 삽입 (마지막 줄바꿈 제외)
      const indented = trimmed.replace(/\n(?!$)/g, '\n  ');
      process.stdout.write(indented);
    } else {
      // 줄바꿈마다 2칸 들여쓰기 삽입 (마지막 줄바꿈 제외)
      const indented = text.replace(/\n(?!$)/g, '\n  ');
      process.stdout.write(indented);
    }

    this.phase = 'streaming';
  }

  /** AI 사고 과정 청크 렌더링 (dim, stderr) */
  renderThoughtChunk(text: string): void {
    // Claude Code 등이 내부 스피너를 thoughtChunk로 전송하는 경우 무시 (예: " ⠧ Working...", "⠹  Claude")
    const cleanText = text
      .split('\n')
      .filter((line) => {
        // ANSI 이스케이프 및 제어 문자(\r 등) 제거 후 검사
        const stripped = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n]/g, '').trim();
        return !/^[\u2800-\u28FF]\s*(Working\.\.\.|Claude)/i.test(stripped);
      })
      .join('\n');

    if (cleanText === '') return;

    if (this.phase !== 'thinking') {
      this.phase = 'thinking';
    }
    process.stderr.write(this.ce.dim(cleanText));
  }

  /** 도구 호출 헤더 렌더링: ⏺ ToolName(args) */
  renderToolCall(title: string, status: string, data?: AcpToolCall): void {
    // 이전 스트리밍 블록과 분리 (stdout 쪽 줄바꿈)
    if (this.phase === 'streaming') {
      process.stdout.write('\n');
    }
    // 이전 사고 블록과 분리 (stderr 쪽 줄바꿈)
    if (this.phase === 'thinking') {
      process.stderr.write('\n');
    }

    // 도구 호출 헤더 출력 (stderr)
    process.stderr.write(`\n${this.ce.bold(this.ce.cyan('⏺'))} ${this.ce.bold(this.ce.cyan(title))}\n`);

    // status가 이미 completed이고 content가 있으면 즉시 결과 렌더링
    if (data && (status === 'completed' || status === 'failed') && (data.content || data.rawOutput)) {
      this.renderToolResult(data.content, data.rawOutput, status === 'failed');
      this.phase = 'idle';
      this.isFirstChunk = true;
      return;
    }

    // 아직 완료되지 않은 도구 호출 추적
    if (data?.toolCallId) {
      this.pendingToolCalls.set(data.toolCallId, { title, toolCallId: data.toolCallId });
    }
    this.phase = 'tool_pending';
  }

  /** 도구 호출 업데이트 렌더링: ⎿ 결과 텍스트 */
  renderToolCallUpdate(_title: string, status: string, data?: AcpToolCallUpdate): void {
    // 완료/실패 상태에서만 결과 렌더링
    if (status !== 'completed' && status !== 'failed') return;

    // 추적 맵에서 제거
    if (data?.toolCallId) {
      this.pendingToolCalls.delete(data.toolCallId);
    }

    const hasContent = data && (data.content || data.rawOutput);
    if (hasContent) {
      this.renderToolResult(data.content ?? undefined, data.rawOutput, status === 'failed');
    }

    this.phase = 'idle';
    this.isFirstChunk = true;
  }

  /** 내부 상태 초기화 (REPL 턴 간 재사용) */
  reset(): void {
    this.phase = 'idle';
    this.isFirstChunk = true;
    this.pendingToolCalls.clear();
  }

  /** 에러 렌더링: ⏺ 오류: message */
  renderError(error: Error): void {
    process.stderr.write(
      `\n${this.ce.bold(this.ce.red('⏺'))} ${this.ce.red(`오류: ${error.message}`)}\n`,
    );
    this.phase = 'idle';
    this.isFirstChunk = true;
  }

  /** 완료 렌더링: ⏺ 완료 (N.Ns) */
  renderComplete(elapsed: string, sessionId?: string | null): void {
    const sessionInfo = sessionId ? ` ${this.ce.dim('|')} ${this.ce.dim(`세션: ${sessionId}`)}` : '';
    process.stderr.write(
      `\n\n${this.ce.bold(this.ce.green('⏺'))} ${this.ce.dim(`완료 (${elapsed}s)`)}${sessionInfo}\n`,
    );
  }

  /**
   * 도구 결과를 ⎿ 프리픽스로 포맷하여 stderr에 출력합니다.
   * 줄 접기: MAX_RESULT_LINES 초과 시 처음 (MAX_RESULT_LINES-1)줄 + "… +N lines"
   */
  private renderToolResult(
    content?: AcpToolCallContent[] | null,
    rawOutput?: unknown,
    isError?: boolean,
  ): void {
    const text = this.extractResultText(content, rawOutput);
    if (!text) return;

    const lines = text.split('\n');

    // 줄 접기
    let displayLines: string[];
    let foldedCount = 0;
    if (lines.length > MAX_RESULT_LINES) {
      displayLines = lines.slice(0, MAX_RESULT_LINES - 1);
      foldedCount = lines.length - (MAX_RESULT_LINES - 1);
    } else {
      displayLines = lines;
    }

    // 색상 적용 함수
    const colorize = isError
      ? (s: string) => this.ce.red(s)
      : (s: string) => this.ce.dim(s);

    // 첫 줄: ⎿ 프리픽스
    for (let i = 0; i < displayLines.length; i++) {
      const prefix = i === 0 ? '  ⎿  ' : '     ';
      process.stderr.write(colorize(`${prefix}${displayLines[i]}`) + '\n');
    }

    // 접힌 줄 표시
    if (foldedCount > 0) {
      process.stderr.write(this.ce.dim(`     … +${foldedCount} lines`) + '\n');
    }
  }

  /**
   * ToolCallContent 배열 또는 rawOutput에서 표시용 텍스트를 추출합니다.
   */
  private extractResultText(
    content?: AcpToolCallContent[] | null,
    rawOutput?: unknown,
  ): string {
    if (content && content.length > 0) {
      const parts: string[] = [];
      for (const item of content) {
        if (item.type === 'content') {
          // Content 타입: content.content 안의 ContentBlock에서 텍스트 추출
          const block = (item as { type: 'content'; content: { type: string; text?: string } }).content;
          if (block && typeof block.text === 'string') {
            parts.push(block.text);
          }
        } else if (item.type === 'diff') {
          // Diff 타입: 경로와 변경 줄 수를 축약 표시
          const diff = item as { type: 'diff'; path: string; newText: string; oldText?: string | null };
          const newLines = diff.newText.split('\n').length;
          const oldLines = diff.oldText?.split('\n').length ?? 0;
          const delta = newLines - oldLines;
          const sign = delta >= 0 ? `+${delta}` : `${delta}`;
          parts.push(`${diff.path}: ${sign} lines`);
        }
        // terminal 타입은 표시하지 않음
      }
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }

    // rawOutput fallback
    if (rawOutput !== undefined && rawOutput !== null) {
      if (typeof rawOutput === 'string') return rawOutput;
      return JSON.stringify(rawOutput, null, 2);
    }

    return '';
  }
}
