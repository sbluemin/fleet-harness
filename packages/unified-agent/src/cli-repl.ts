/**
 * REPL 모드 — 인터랙티브 세션
 * readline/promises 기반, 슬래시 커맨드, Ctrl+C 핸들링을 포함합니다.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { CliRenderer } from './cli-renderer.js';
import type { ColorFns } from './cli-renderer.js';
import { UnifiedAgent, type IUnifiedAgentClient } from './client/IUnifiedAgentClient.js';
import {
  getProviderModelIds,
  getProviderModels,
  getEffort,
  getEffortLevels,
} from './models/ModelRegistry.js';
import type { CliType } from './types/config.js';
import type { AcpPermissionRequestParams, AcpPermissionResponse } from './types/acp.js';

// ─── 타입 (내부) ────────────────────────────────────────

/** 미해결 권한 요청의 resolve 함수 참조 */
type PendingPermissionResolve = ((response: AcpPermissionResponse) => void) | null;

// ─── 타입 ───────────────────────────────────────────────

/** REPL 시작 옵션 */
export interface ReplOptions {
  cli?: CliType;
  session?: string;
  model?: string;
  effort?: string;
  cwd: string;
  yolo: boolean;
  color: ColorFns;
  colorErr: ColorFns;
}

// ─── 상수 ───────────────────────────────────────────────

/** Ctrl+C double-tap 종료 윈도우 (ms) */
const DOUBLE_TAP_WINDOW = 1500;

// ─── 메인 ───────────────────────────────────────────────

/**
 * 인터랙티브 REPL 세션을 시작합니다.
 * 연결 → 이벤트 설정 → 입력 루프 → 종료 순서로 실행됩니다.
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const { cli: selectedCli, session: sessionOpt, model: modelOpt, effort: effortOpt, cwd, yolo } = options;
  const ce = options.colorErr;

  let client: IUnifiedAgentClient;
  const renderer = new CliRenderer({ color: options.color, colorErr: ce });

  // ─── 연결 ─────────────────────────────────────────────

  process.stderr.write(`${ce.bold(ce.cyan('⏺'))} ${ce.bold('ait')} ${ce.dim('연결 중...')}\n`);

  let connectedCli: CliType;
  try {
    client = await UnifiedAgent.build({ cli: selectedCli, sessionId: sessionOpt });
    const result = await client.connect({
      cwd,
      cli: selectedCli,
      autoApprove: false,
      yoloMode: yolo,
      model: modelOpt,
      effort: effortOpt,
      sessionId: sessionOpt,
    });
    connectedCli = result.cli;
  } catch (err) {
    process.stderr.write(`${ce.red('오류')}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // effort 초기 설정
  const connectedProvider = getProviderModels(connectedCli);
  const initialModel = modelOpt ?? connectedProvider.defaultModel;
  const initialEffort = getEffort(connectedCli, initialModel);
  let requestedEffort: string | null = null;

  if (effortOpt && initialEffort.supported) {
    if (!initialEffort.levels.includes(effortOpt)) {
      process.stderr.write(
        `${ce.red('오류')}: ${connectedCli}/${initialModel} 모델은 --effort=${effortOpt} 를 지원하지 않습니다. 사용 가능: ${initialEffort.levels.join(', ')}\n`,
      );
      await client.disconnect();
      process.exit(1);
    }

    requestedEffort = effortOpt;
    if (isClaudeCli(connectedCli)) {
      process.stderr.write(`${ce.dim('⚠ Claude의 effort 변경은 다음 새 세션부터 적용됩니다')}\n`);
    } else {
      try {
        await client.setConfigOption('effort', effortOpt);
      } catch {
        process.stderr.write(`${ce.dim('⚠ reasoning effort 설정 미지원 (이 CLI에서는 사용할 수 없습니다)')}\n`);
      }
    }
  } else if (effortOpt && !initialEffort.supported) {
    process.stderr.write(
      `${ce.dim(`⚠ ${connectedCli}/${initialModel} 모델은 reasoning effort를 지원하지 않아 --effort=${effortOpt} 를 무시합니다`)}\n`,
    );
  }

  // 로컬 상태 추적 (API getter 없으므로)
  let currentModel: string = initialModel;
  let currentEffort: string | null = requestedEffort;
  let isStreaming = false;
  let pendingPermissionResolve: PendingPermissionResolve = null;
  let cleanupPromise: Promise<void> | null = null;

  process.stderr.write(`${ce.dim(`  → ${connectedCli} 연결됨`)}\n\n`);

  // ─── readline 설정 ────────────────────────────────────

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: buildPrompt(currentModel, currentEffort, ce),
  });

  // ─── 이벤트 리스너 ────────────────────────────────────

  client.on('messageChunk', (text) => {
    renderer.renderMessageChunk(text);
  });

  client.on('thoughtChunk', (text) => {
    renderer.renderThoughtChunk(text);
  });

  client.on('toolCall', (title, status, _sid, data) => {
    renderer.renderToolCall(title, status, data);
  });

  client.on('toolCallUpdate', (title, status, _sid, data) => {
    renderer.renderToolCallUpdate(title, status, data);
  });

  client.on('error', (err) => {
    renderer.renderError(err);
  });

  client.on('exit', () => {
    process.stderr.write(`\n${ce.red('연결이 끊어졌습니다.')}\n`);
    rl.close();
  });

  // 권한 요청 처리 — 메인 rl을 재사용하여 이중 readline 방지
  client.on('permissionRequest', (params, resolve) => {
    handlePermissionRequest(params, resolve, rl, ce, yolo, (fn) => { pendingPermissionResolve = fn; });
  });

  // ─── Ctrl+C 핸들링 ───────────────────────────────────

  let lastSigintTime = 0;

  rl.on('SIGINT', () => {
    // 미해결 권한 요청이 있으면 취소 처리
    if (pendingPermissionResolve) {
      const fn = pendingPermissionResolve;
      pendingPermissionResolve = null;
      fn({ outcome: { outcome: 'cancelled' } });
      rl.prompt();
      return;
    }

    if (isStreaming) {
      // 스트리밍 중 → 현재 프롬프트 취소
      client.cancelPrompt().catch(() => {
        // 취소 실패 시 무시 (이미 완료되었을 수 있음)
      });
      return;
    }

    // 입력 대기 중 → double-tap 종료
    const now = Date.now();
    if (now - lastSigintTime < DOUBLE_TAP_WINDOW) {
      // 두 번째 Ctrl+C → 종료
      process.stderr.write('\n');
      void cleanup();
      return;
    }

    lastSigintTime = now;
    process.stderr.write(`\n${ce.dim('종료하려면 Ctrl+C를 한 번 더 누르세요')}\n`);
    rl.prompt();
  });

  // ─── 메인 루프 ────────────────────────────────────────

  // readline 'close' 이벤트로 루프 탈출을 제어
  let running = true;
  rl.on('close', () => {
    running = false;
    // 미해결 권한 요청이 있으면 취소 처리 (EOF/Ctrl+D)
    if (pendingPermissionResolve) {
      const fn = pendingPermissionResolve;
      pendingPermissionResolve = null;
      fn({ outcome: { outcome: 'cancelled' } });
    }
  });

  rl.prompt();

  for await (const line of rl) {
    if (!running) break;

    const trimmed = line.trim();

    // 빈 입력 무시
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // 슬래시 커맨드 처리
    if (trimmed.startsWith('/')) {
      const shouldExit = await handleSlashCommand(trimmed, client, connectedCli, ce, {
        currentModel,
        currentEffort,
        setModel: (m: string) => { currentModel = m; },
        setEffort: (e: string | null) => { currentEffort = e; },
      });

      if (shouldExit) {
        await cleanup();
        return;
      }

      // 프롬프트 갱신 (모델/effort 변경 반영)
      rl.setPrompt(buildPrompt(currentModel, currentEffort, ce));
      rl.prompt();
      continue;
    }

    // 메시지 전송
    renderer.reset();
    isStreaming = true;

    try {
      await client.sendMessage(trimmed);
    } catch (err) {
      renderer.renderError(err as Error);
    }

    isStreaming = false;
    // 응답 끝 줄바꿈
    process.stdout.write('\n');
    rl.prompt();
  }

  // readline이 닫힌 경우 (EOF 등)
  await cleanup();

  // ─── 정리 함수 ────────────────────────────────────────

  /** idempotent cleanup — 중복 호출 시 기존 Promise 재사용 */
  async function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const sid = client.getConnectionInfo().sessionId;
      if (sid) {
        process.stderr.write(`${ce.dim(`세션: ${sid}`)}\n`);
      }
      await client.disconnect();
      process.exit(0);
    })();
    return cleanupPromise;
  }
}

// ─── 프롬프트 생성 ──────────────────────────────────────

/** REPL 프롬프트 문자열 생성: `ait (model) (effort) ❯ ` */
function buildPrompt(model: string, effort: string | null, ce: ColorFns): string {
  const parts = [`${ce.bold('ait')}`, `${ce.cyan(`(${model})`)}`];
  if (effort) {
    parts.push(ce.dim(`(${effort})`));
  }
  return `${parts.join(' ')} ${ce.bold('❯')} `;
}

// ─── 슬래시 커맨드 ──────────────────────────────────────

interface ReplState {
  currentModel: string;
  currentEffort: string | null;
  setModel: (m: string) => void;
  setEffort: (e: string | null) => void;
}

interface EffortCommandContext {
  cli: CliType;
  arg: string;
  ce: ColorFns;
  currentModel: string;
  setEffort: (effort: string | null) => void;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  writeLine: (text: string) => void;
}

/**
 * 슬래시 커맨드를 처리합니다.
 * @returns true면 REPL 종료
 */
async function handleSlashCommand(
  input: string,
  client: IUnifiedAgentClient,
  cli: CliType,
  ce: ColorFns,
  state: ReplState,
): Promise<boolean> {
  const [cmd, ...args] = input.split(/\s+/);
  const arg = args.join(' ').trim();

  switch (cmd) {
    case '/model': {
      if (!arg) {
        // 인자 없으면 모델 목록 출력
        const modelIds = getProviderModelIds(cli);
        process.stderr.write(`${ce.bold('사용 가능한 모델:')}\n`);
        for (const id of modelIds) {
          const marker = id === state.currentModel ? ce.green('*') : ' ';
          process.stderr.write(`  ${marker} ${ce.cyan(id)}\n`);
        }
        return false;
      }

      try {
        getEffort(cli, arg);
        await client.setModel(arg);
        state.setModel(arg);
        await applyDefaultEffortForModel(cli, arg, client, state, ce, (text) => { process.stderr.write(text); });
        process.stderr.write(`${ce.dim(`모델 변경: ${arg}`)}\n`);
      } catch (err) {
        process.stderr.write(`${ce.red('오류')}: ${(err as Error).message}\n`);
      }
      return false;
    }

    case '/effort': {
      if (!arg) {
        // 인자 없으면 레벨 목록 출력
        handleEffortLevelsSlashCommand(cli, ce, state.currentEffort, state.currentModel, (text) => { process.stderr.write(text); });
        return false;
      }

      await handleEffortSlashCommand({
        cli,
        arg,
        ce,
        currentModel: state.currentModel,
        setEffort: state.setEffort,
        setConfigOption: (configId, value) => client.setConfigOption(configId, value),
        writeLine: (text) => { process.stderr.write(text); },
      });
      return false;
    }

    case '/status': {
      const info = client.getConnectionInfo();
      process.stderr.write(`${ce.bold('상태:')}\n`);
      process.stderr.write(`  CLI:     ${ce.cyan(cli)}\n`);
      process.stderr.write(`  모델:    ${ce.cyan(state.currentModel)}\n`);
      process.stderr.write(`  effort:  ${state.currentEffort ? ce.cyan(state.currentEffort) : ce.dim('없음')}\n`);
      process.stderr.write(`  세션:    ${info.sessionId ? ce.dim(info.sessionId) : ce.dim('없음')}\n`);
      process.stderr.write(`  상태:    ${ce.dim(info.state)}\n`);
      return false;
    }

    case '/clear': {
      // 화면만 클리어 (서버 히스토리 유지)
      process.stderr.write('\u001b[2J\u001b[H');
      return false;
    }

    case '/help': {
      process.stderr.write(`${ce.bold('슬래시 커맨드:')}\n`);
      process.stderr.write(`  ${ce.cyan('/model <id>')}    모델 변경 (인자 없으면 목록 출력)\n`);
      process.stderr.write(`  ${ce.cyan('/effort <lv>')}   reasoning effort 변경 (지원 CLI만, 인자 없으면 목록 출력)\n`);
      process.stderr.write(`  ${ce.cyan('/status')}        현재 연결 상태 표시\n`);
      process.stderr.write(`  ${ce.cyan('/clear')}         화면 클리어\n`);
      process.stderr.write(`  ${ce.cyan('/help')}          이 도움말 표시\n`);
      process.stderr.write(`  ${ce.cyan('/exit')}          REPL 종료\n`);
      return false;
    }

    case '/exit': {
      return true;
    }

    default: {
      process.stderr.write(`${ce.red('알 수 없는 명령어')}. ${ce.dim('/help를 입력하세요')}\n`);
      return false;
    }
  }
}

async function applyDefaultEffortForModel(
  cli: CliType,
  model: string,
  client: IUnifiedAgentClient,
  state: ReplState,
  ce: ColorFns,
  writeLine: (text: string) => void,
): Promise<void> {
  const effort = getEffort(cli, model);
  if (!effort.supported) {
    state.setEffort(null);
    return;
  }

  if (isClaudeCli(cli)) {
    state.setEffort(effort.default);
    writeLine(`${ce.dim(`Claude의 기본 effort ${effort.default}는 다음 새 세션부터 적용됩니다`)}\n`);
    return;
  }

  await client.setConfigOption('effort', effort.default);
  state.setEffort(effort.default);
}

export async function handleEffortSlashCommand(context: EffortCommandContext): Promise<void> {
  const { cli, arg, ce, currentModel, setEffort, setConfigOption, writeLine } = context;
  const levels = getEffortLevels(cli, currentModel);

  if (!levels) {
    writeLine(`${ce.dim(`${cli}/${currentModel} 모델은 reasoning effort를 지원하지 않아 /effort ${arg} 를 무시합니다`)}\n`);
    return;
  }

  if (!levels.includes(arg)) {
    writeLine(`${ce.red('오류')}: ${cli}/${currentModel} 모델은 /effort ${arg} 를 지원하지 않습니다. 사용 가능: ${levels.join(', ')}\n`);
    return;
  }

  try {
    if (isClaudeCli(cli)) {
      setEffort(arg);
      writeLine(`${ce.dim(`Claude의 effort ${arg}는 다음 새 세션부터 적용됩니다`)}\n`);
      return;
    }

    await setConfigOption('effort', arg);
    setEffort(arg);
    writeLine(`${ce.dim(`reasoning effort 변경: ${arg}`)}\n`);
  } catch {
    writeLine(`${ce.red('오류')}: reasoning effort 설정 실패 (이 CLI에서는 지원되지 않을 수 있습니다)\n`);
  }
}

function isClaudeCli(cli: CliType): cli is 'claude' | 'claude-zai' | 'claude-kimi' {
  return cli === 'claude' || cli === 'claude-zai' || cli === 'claude-kimi';
}

function handleEffortLevelsSlashCommand(
  cli: CliType,
  ce: ColorFns,
  currentEffort: string | null,
  currentModel: string,
  writeLine: (text: string) => void,
): void {
  const levels = getEffortLevels(cli, currentModel);

  if (!levels) {
    writeLine(`${ce.dim(`이 모델은 reasoning effort를 지원하지 않아 /effort 명령을 무시합니다.`)}\n`);
    return;
  }

  writeLine(`${ce.bold('사용 가능한 레벨:')}\n`);
  for (const level of levels) {
    const marker = level === currentEffort ? ce.green('*') : ' ';
    writeLine(`  ${marker} ${ce.cyan(level)}\n`);
  }
}

// ─── 권한 요청 처리 ─────────────────────────────────────

/**
 * 에이전트의 권한 요청을 처리합니다.
 * --yolo 모드면 자동 승인, 아니면 메인 rl을 사용해 Y/n 프롬프트를 표시합니다.
 * 별도 readline을 생성하지 않으므로 이중 readline 충돌이 발생하지 않습니다.
 */
function handlePermissionRequest(
  params: AcpPermissionRequestParams,
  resolve: (response: AcpPermissionResponse) => void,
  rl: ReadlineInterface,
  ce: ColorFns,
  yolo: boolean,
  setPending: (fn: PendingPermissionResolve) => void,
): void {
  // 승인 옵션 찾기 (allow_once 우선, 없으면 allow_always)
  const allowOption = params.options.find((o) => o.kind === 'allow_once')
    ?? params.options.find((o) => o.kind === 'allow_always');
  const rejectOption = params.options.find((o) => o.kind === 'reject_once')
    ?? params.options.find((o) => o.kind === 'reject_always');

  if (yolo && allowOption) {
    resolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } });
    return;
  }

  if (!allowOption) {
    // 승인 옵션이 없으면 취소
    resolve({ outcome: { outcome: 'cancelled' } });
    return;
  }

  // 도구 정보 출력
  const toolTitle = params.toolCall.title ?? '도구 호출';
  process.stderr.write(`\n${ce.bold(ce.cyan('⏺'))} ${ce.bold('권한 요청')}: ${ce.cyan(toolTitle)}\n`);

  // 옵션 목록 표시
  for (const opt of params.options) {
    process.stderr.write(`  ${ce.dim(`[${opt.optionId}]`)} ${opt.name} ${ce.dim(`(${opt.kind})`)}\n`);
  }

  // guard — 한 번만 resolve되도록 보장
  let resolved = false;
  const safeResolve = (response: AcpPermissionResponse): void => {
    if (resolved) return;
    resolved = true;
    setPending(null);
    resolve(response);
  };

  // 미해결 상태 등록 (SIGINT/close에서 자동 cancelled 처리용)
  setPending(safeResolve);

  // 메인 rl을 사용하여 Y/n 프롬프트
  rl.question(`${ce.bold('허용하시겠습니까?')} ${ce.dim('[Y/n]')} `, (answer) => {
    const normalized = answer.trim().toLowerCase();
    if (normalized === '' || normalized === 'y' || normalized === 'yes') {
      safeResolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } });
    } else if (rejectOption) {
      safeResolve({ outcome: { outcome: 'selected', optionId: rejectOption.optionId } });
    } else {
      safeResolve({ outcome: { outcome: 'cancelled' } });
    }
  });
}
