/**
 * 원샷 CLI 실행 로직
 * 기존 cli.ts의 실행부를 함수로 추출한 모듈
 */

import { CliRenderer } from './cli-renderer.js';
import type { ColorFns } from './cli-renderer.js';
import { UnifiedAgent } from './client/IUnifiedAgentClient.js';
import { getProviderModels, getEffort } from './models/ModelRegistry.js';
import type { IUnifiedAgentClient } from './client/IUnifiedAgentClient.js';
import type { CliType } from './types/config.js';

// ─── 타입 ───────────────────────────────────────────────

/** 원샷 실행 옵션 */
export interface OneShotOptions {
  /** 프롬프트 텍스트 */
  prompt: string;
  /** CLI 선택 */
  cli?: CliType;
  /** 세션 ID (재개) */
  session?: string;
  /** 모델 지정 */
  model?: string;
  /** effort */
  effort?: string;
  /** 작업 디렉토리 */
  cwd: string;
  /** YOLO 모드 */
  yolo: boolean;
  /** JSON 출력 */
  json: boolean;
  /** stdout 색상 함수 */
  color: ColorFns;
  /** stderr 색상 함수 */
  colorErr: ColorFns;
}

// ─── 실행 ───────────────────────────────────────────────

/**
 * 원샷 모드로 프롬프트를 실행하고 종료합니다.
 * 기존 unified-agent CLI의 동작을 100% 유지합니다.
 */
export async function runOneShot(options: OneShotOptions): Promise<void> {
  const { prompt, cli: selectedCli, session: sessionOpt, model, effort: effortOpt, cwd, yolo, json: jsonMode, color: c, colorErr: ce } = options;

  const startTime = Date.now();
  const renderer = new CliRenderer({ color: c, colorErr: ce });
  let client: IUnifiedAgentClient | null = null;
  let fullResponse = '';
  let isLivePrompt = false;

  try {
    client = await UnifiedAgent.build({ cli: selectedCli, sessionId: sessionOpt });

    // 이벤트 리스너 설정 (세션 재개 시 replay 이벤트는 무시)
    client.on('messageChunk', (text) => {
      if (!isLivePrompt) return;
      fullResponse += text;
      if (!jsonMode) renderer.renderMessageChunk(text);
    });

    // error 리스너는 모드 무관하게 항상 등록 (미등록 시 Unhandled 'error' event crash)
    client.on('error', (err) => {
      if (!jsonMode) renderer.renderError(err);
    });

    if (!jsonMode) {
      client.on('thoughtChunk', (text) => {
        if (!isLivePrompt) return;
        renderer.renderThoughtChunk(text);
      });

      client.on('toolCall', (title, status, _sid, data) => {
        if (!isLivePrompt) return;
        renderer.renderToolCall(title, status, data);
      });

      client.on('toolCallUpdate', (title, status, _sid, data) => {
        if (!isLivePrompt) return;
        renderer.renderToolCallUpdate(title, status, data);
      });
    }

    if (!jsonMode) {
      const resumeLabel = sessionOpt ? `, resume: ${sessionOpt.slice(0, 8)}…` : '';
      const cliLabel = selectedCli ?? '자동 감지';
      renderer.renderHeader(cliLabel, resumeLabel);
    }

    const result = await client.connect({
      cwd,
      cli: selectedCli,
      autoApprove: true,
      yoloMode: yolo,
      model,
      effort: effortOpt,
      sessionId: sessionOpt,
    });

    const provider = getProviderModels(result.cli);
    const connectedModel = model ?? provider.defaultModel;
    const effort = getEffort(result.cli, connectedModel);

    // effort 설정
    if (effortOpt && effort.supported && effort.levels.includes(effortOpt)) {
      if (!isClaudeCli(result.cli)) {
        try {
          await client.setConfigOption('effort', effortOpt);
        } catch {
          // effort 설정 미지원 CLI인 경우 무시
        }
      }
    } else if (effortOpt && effort.supported) {
      throw new Error(
        `${result.cli}/${connectedModel} 모델은 --effort=${effortOpt} 를 지원하지 않습니다. 사용 가능: ${effort.levels.join(', ')}`,
      );
    } else if (effortOpt && !jsonMode) {
      process.stderr.write(
        `${ce.dim(`⚠ ${result.cli}/${connectedModel} 모델은 reasoning effort를 지원하지 않아 --effort=${effortOpt} 를 무시합니다`)}\n`,
      );
    }

    if (!jsonMode) {
      // 헤더에 실제 연결된 CLI 표시 (자동 감지된 경우)
      if (!selectedCli) {
        renderer.renderAutoDetected(result.cli);
      }
    }

    // 세션 로드 중 재생된 이벤트 무시 후, 현재 프롬프트부터 출력 시작
    fullResponse = '';
    isLivePrompt = true;

    await client.sendMessage(prompt);

    if (!jsonMode) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sid = client.getConnectionInfo().sessionId;
      renderer.renderComplete(elapsed, sid);
    }

    if (jsonMode) {
      const sid = client.getConnectionInfo().sessionId;
      await stdoutWrite(
        JSON.stringify({ response: fullResponse, cli: result.cli, sessionId: sid }) + '\n',
      );
    }
  } catch (err) {
    const sid = client?.getConnectionInfo().sessionId;
    if (!jsonMode) {
      const sessionInfo = sid ? ` ${ce.dim(`(세션: ${sid})`)}` : '';
      process.stderr.write(`\n${ce.red('오류')}: ${(err as Error).message}${sessionInfo}\n`);
    } else {
      await stdoutWrite(
        JSON.stringify({ error: (err as Error).message, sessionId: sid ?? null }) + '\n',
      );
    }
    process.exitCode = 1;
  } finally {
    await client?.disconnect();
    process.exit(process.exitCode ?? 0);
  }
}

// stdout에 데이터를 쓰고 flush가 완료된 후 resolve하는 헬퍼
// process.stdout.write()는 파이프 환경(non-TTY)에서 비동기이므로,
// process.exit() 전에 write 콜백을 기다려야 데이터 유실을 방지할 수 있음
function stdoutWrite(data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    process.stdout.write(data, () => resolve());
  });
}

function isClaudeCli(cli: CliType): cli is 'claude' | 'claude-zai' | 'claude-kimi' {
  return cli === 'claude' || cli === 'claude-zai' || cli === 'claude-kimi';
}
