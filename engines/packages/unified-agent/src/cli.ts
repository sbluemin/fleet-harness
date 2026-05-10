#!/usr/bin/env node

/**
 * ait CLI — 통합 진입점
 * 인자 있음 → 원샷 모드, 인자 없음 + TTY → REPL 모드
 */

import { parseArgs } from 'node:util';
import picocolors from 'picocolors';

import { CLI_BACKENDS } from './config/CliConfigs.js';
import { getModelsRegistry, getProviderModels } from './models/ModelRegistry.js';
import { runOneShot } from './cli-oneshot.js';
import { startRepl } from './cli-repl.js';
import type { CliType } from './types/config.js';

// Claude Code 내부에서 실행될 때 환경변수 충돌 방지
// (cli.ts 프로세스 자체가 Claude Code 세션 안에서 spawn되므로 즉시 제거)
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

// ─── ANSI 색상 (TTY일 때만 활성화) ─────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const isErrTTY = process.stderr.isTTY ?? false;

const c = picocolors.createColors(picocolors.isColorSupported && isTTY);
const ce = picocolors.createColors(picocolors.isColorSupported && isErrTTY);

// ─── 인자 파싱 ────────────────────────────────────────────

const VALID_CLIS = Object.keys(CLI_BACKENDS) as CliType[];
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    options: {
      cli: { type: 'string', short: 'c' },
      session: { type: 'string', short: 's' },
      model: { type: 'string', short: 'm' },
      effort: { type: 'string', short: 'e' },
      cwd: { type: 'string', short: 'd' },
      yolo: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'list-models': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
} catch (err) {
  process.stderr.write(`${ce.red('오류')}: ${(err as Error).message}\n`);
  process.stderr.write(`도움말: ait --help\n`);
  process.exit(1);
}

const { values, positionals } = parsed;

// ─── 도움말 ──────────────────────────────────────────────

if (values.help) {
  const help = `
${c.bold('ait')} — Gemini, Claude, Codex 통합 CLI

${c.bold('사용법')}
  ait [옵션] <프롬프트>       원샷 모드
  ait [옵션]                 인터랙티브 REPL 모드
  echo "프롬프트" | ait [옵션]

${c.bold('옵션')}
  -c, --cli <name>      CLI 선택 (gemini | claude | claude-zai | claude-kimi | codex | opencode-go)
  -s, --session <id>    이전 세션 재개 (사용 시 -c 필수)
  -m, --model <name>    모델 지정
  -e, --effort <level>  reasoning effort (모델별 지원 시에만 적용)
  -d, --cwd <path>      작업 디렉토리 (기본: 현재 디렉토리)
      --yolo             자동 권한 승인 모드
      --json             JSON 출력
      --list-models      사용 가능한 모델 목록 출력
  -h, --help             도움말

${c.bold('예시')}
  ${c.dim('# 자동 감지된 CLI로 실행')}
  ait "이 프로젝트를 분석해줘"

  ${c.dim('# Claude로 실행, 모델 지정')}
  ait -c claude -m opus "코드를 리뷰해줘"

  ${c.dim('# Codex로 실행, reasoning effort 설정')}
  ait -c codex -e high "버그를 찾아줘"

  ${c.dim('# Claude Sonnet은 low | medium | high | max 지원')}
  ait -c claude -m sonnet -e max "코드를 리뷰해줘"

  ${c.dim('# stdin 파이프')}
  cat error.log | ait -c gemini "이 에러를 분석해줘"

  ${c.dim('# 이전 세션 재개')}
  ait -c claude -s <sessionId> "이어서 설명해줘"

  ${c.dim('# JSON 출력 (스크립트에서 파싱 용도)')}
  ait --json -c claude "요약해줘" | jq .response

  ${c.dim('# 인터랙티브 REPL 모드')}
  ait -c claude
`;
  process.stdout.write(help.trimStart());
  process.exit(0);
}

// ─── 모델 목록 출력 ──────────────────────────────────────

if (values['list-models']) {
  const cliFilter = values.cli as string | undefined;
  const jsonOut = values.json as boolean;
  const registry = getModelsRegistry();

  // 출력 대상 프로바이더 결정
  const providerKeys = cliFilter
    ? [cliFilter]
    : Object.keys(registry.providers);

  if (cliFilter && !registry.providers[cliFilter]) {
    process.stderr.write(
      `${ce.red('오류')}: 알 수 없는 CLI "${cliFilter}". 사용 가능: ${Object.keys(registry.providers).join(', ')}\n`,
    );
    process.exit(1);
  }

  if (jsonOut) {
    // JSON 모드: 필터된 레지스트리 출력
    const filtered = cliFilter
      ? { [cliFilter]: registry.providers[cliFilter] }
      : registry.providers;
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
  } else {
    // TTY: 테이블 형태 출력
    for (const key of providerKeys) {
      const provider = getProviderModels(key as CliType);
      process.stdout.write(`\n${c.bold(provider.name)} ${c.dim(`(${key})`)}\n`);
      process.stdout.write(`${c.dim('기본 모델:')} ${provider.defaultModel}\n`);

      process.stdout.write('\n');
      for (const model of provider.models) {
        const isDefault = model.modelId === provider.defaultModel;
        const marker = isDefault ? c.green('*') : ' ';
        const effort = model.effort.supported
          ? `  ${c.dim(`effort: ${model.effort.levels.join(', ')} (기본: ${model.effort.default})`)}`
          : '';
        process.stdout.write(`  ${marker} ${c.cyan(model.modelId)}  ${c.dim(model.name)}${effort}\n`);
      }
    }
    process.stdout.write('\n');
  }

  process.exit(0);
}

// ─── 옵션 검증 ──────────────────────────────────────────

const cliOpt = values.cli as string | undefined;
if (cliOpt && !VALID_CLIS.includes(cliOpt as CliType)) {
  process.stderr.write(
    `${ce.red('오류')}: 알 수 없는 CLI "${cliOpt}". 사용 가능: ${VALID_CLIS.join(', ')}\n`,
  );
  process.exit(1);
}

const rawSessionOpt = values.session as string | undefined;
const sessionOpt = rawSessionOpt?.trim();
if (rawSessionOpt !== undefined && !sessionOpt) {
  process.stderr.write(`${ce.red('오류')}: --session 값은 비어 있을 수 없습니다.\n`);
  process.exit(1);
}

if (sessionOpt && !cliOpt) {
  process.stderr.write(`${ce.red('오류')}: --session 사용 시 --cli를 함께 지정해야 합니다.\n`);
  process.exit(1);
}

const effortOpt = values.effort as string | undefined;
if (effortOpt && !VALID_EFFORTS.includes(effortOpt as (typeof VALID_EFFORTS)[number])) {
  process.stderr.write(
    `${ce.red('오류')}: 알 수 없는 effort "${effortOpt}". 사용 가능: ${VALID_EFFORTS.join(', ')}\n`,
  );
  process.exit(1);
}

// ─── 모드 분기 ──────────────────────────────────────────

const cwd = (values.cwd as string) || process.cwd();
const selectedCli = cliOpt as CliType | undefined;
const yolo = values.yolo as boolean;
const jsonMode = values.json as boolean;
const modelOpt = values.model as string | undefined;

let prompt = positionals.join(' ');
const hasPipedInput = !process.stdin.isTTY;

// --json은 원샷 모드에서만 사용 가능
if (jsonMode && !prompt && !hasPipedInput) {
  process.stderr.write(`${ce.red('오류')}: --json 플래그는 프롬프트와 함께 사용해야 합니다.\n`);
  process.stderr.write(`예시: ait --json -c claude "요약해줘"\n`);
  process.exit(1);
}

if (prompt || hasPipedInput) {
  // 파이프 입력이 있으면 읽어서 프롬프트에 추가
  if (!prompt && hasPipedInput) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString().trim();
  }

  if (!prompt) {
    process.stderr.write(`${ce.red('오류')}: 프롬프트를 입력해주세요.\n`);
    process.stderr.write(`도움말: ait --help\n`);
    process.exit(1);
  }

  // 원샷 모드
  await runOneShot({
    prompt,
    cli: selectedCli,
    session: sessionOpt,
    model: modelOpt,
    effort: effortOpt,
    cwd,
    yolo,
    json: jsonMode,
    color: c,
    colorErr: ce,
  });
} else if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) {
  // REPL 모드
  await startRepl({
    cli: selectedCli,
    session: sessionOpt,
    model: modelOpt,
    effort: effortOpt,
    cwd,
    yolo,
    color: c,
    colorErr: ce,
  });
} else {
  // non-TTY + 인자 없음 → 에러
  process.stderr.write(`${ce.red('오류')}: 프롬프트를 입력해주세요.\n`);
  process.stderr.write(`도움말: ait --help\n`);
  process.exit(1);
}
