import fs from "node:fs/promises";

import { applyClaudeNativeModels, type ClaudeNativeModelRow } from "../models.js";

/** 설치 표식을 다시 읽기까지의 최소 간격. CLI 자동 업데이트를 따라잡는 데 충분히 짧다. */
const CLAUDE_INSTALL_RECHECK_MS = 60_000;

export interface ClaudeNativeModelSyncDeps {
  /** 호스트가 실제로 띄우는 Claude Code 실행 파일. 못 찾으면 `undefined`다. */
  readonly resolveExecutable: () => Promise<string | undefined>;
  /** 그 실행 파일에게 `/model` 표를 묻는다. */
  readonly readSupportedModels: (executable: string | undefined) => Promise<readonly ClaudeNativeModelRow[]>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface ClaudeNativeModelSync {
  /**
   * Claude alias가 최신 버전으로 풀린 카탈로그를 보장한다. 처음이거나 설치가 바뀌었을 때만
   * CLI에 묻고, 실패는 마지막으로 받은 표를 그대로 둔 채 조용히 끝난다.
   */
  ensure(): Promise<void>;
}

/**
 * Claude alias가 가리키는 최신 버전을 설치된 CLI에서 받아 카탈로그에 싣는다.
 *
 * 기동 시점이 아니라 필요한 순간에 묻는다 — Claude 모델을 쓰지 않는 Console은 CLI를 띄울 이유가
 * 없다. 조회 실패는 틀린 버전으로 바꾸지 않고 알던 표를 유지하며, 다음 필요 시점에 다시 묻는다.
 */
export function createClaudeNativeModelSync(deps: ClaudeNativeModelSyncDeps): ClaudeNativeModelSync {
  const now = deps.now ?? Date.now;
  let stamp: string | undefined;
  let synced = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let failedAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;

  /**
   * 설치가 바뀌면 달라지는 값. 네이티브 설치기는 버전마다 새 파일을 두고 링크를 옮기므로 실경로가,
   * 제자리 갱신은 크기·수정 시각이 바뀐다. 못 읽으면 표식으로 가를 수 없어 알던 표를 쓴다.
   */
  const readStamp = async (executable: string | undefined): Promise<string | undefined> => {
    if (!executable) return undefined;
    try {
      const real = await fs.realpath(executable);
      const stat = await fs.stat(real);
      return `${real}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  };

  const sync = async (): Promise<void> => {
    if (synced) {
      if (now() - checkedAt < CLAUDE_INSTALL_RECHECK_MS) return;
      checkedAt = now();
      const current = await readStamp(await deps.resolveExecutable().catch(() => undefined));
      if (current === undefined || current === stamp) return;
    } else if (now() - failedAt < CLAUDE_INSTALL_RECHECK_MS) {
      // CLI가 없거나 답하지 않는 설치에 요청마다 자식을 띄우지 않는다.
      return;
    }
    try {
      const executable = await deps.resolveExecutable();
      const nextStamp = await readStamp(executable);
      applyClaudeNativeModels(await deps.readSupportedModels(executable));
      stamp = nextStamp;
      synced = true;
      checkedAt = now();
    } catch (error) {
      failedAt = now();
      deps.onError?.(error);
    }
  };

  return {
    ensure: () => {
      running ??= sync().finally(() => { running = undefined; });
      return running;
    },
  };
}
