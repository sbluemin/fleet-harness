/**
 * UnifiedAgent - CLI별 특수화 클라이언트를 생성하는 SDK 진입점
 *
 * provider 구현 선택(빌더) 책임만 가지며, API 계약 타입은
 * IUnifiedAgentClient.ts에 정의됩니다.
 */

import { UnifiedClaudeAgentClient } from './UnifiedClaudeAgentClient.js';
import { UnifiedCodexAgentClient } from './UnifiedCodexAgentClient.js';
import { UnifiedCursorAgentClient } from './UnifiedCursorAgentClient.js';
import { UnifiedOpenCodeAgentClient } from './UnifiedOpenCodeAgentClient.js';
import { CliDetector } from '../detector/CliDetector.js';
import type { CliType } from '../config/CliConfigs.js';
import type { UnifiedClientOptions } from '../types/config.js';
import type {
  IUnifiedAgentClient,
  UnifiedAgentBuildOptions,
} from './IUnifiedAgentClient.js';

/** CLI별 특수화 클라이언트를 생성하는 SDK 진입점 */
export const UnifiedAgent = {
  createClient(cli: CliType): IUnifiedAgentClient {
    switch (cli) {
      case 'claude':
      case 'claude-kimi':
        return new UnifiedClaudeAgentClient(cli);
      case 'codex':
        return new UnifiedCodexAgentClient();
      case 'opencode-go':
        return new UnifiedOpenCodeAgentClient('opencode-go');
      case 'cursor':
        return new UnifiedCursorAgentClient();
    }
  },

  async build(
    options: UnifiedAgentBuildOptions = {},
  ): Promise<IUnifiedAgentClient> {
    if (options.sessionId && !options.cli) {
      throw new Error('세션 재개 시 cli 지정이 필요합니다.');
    }

    if (options.cli) {
      return this.createClient(options.cli);
    }

    const preferred = await new CliDetector().getPreferred();
    if (!preferred) {
      throw new Error(
        '사용 가능한 CLI가 없습니다. claude, claude-kimi, codex, opencode-go, cursor 중 하나를 설치해주세요.',
      );
    }

    return this.createClient(preferred.cli);
  },

  async connect(options: UnifiedClientOptions): Promise<IUnifiedAgentClient> {
    const client = await this.build({
      cli: options.cli,
      sessionId: options.sessionId,
    });
    await client.connect(options);
    return client;
  },
};
