import { mkdtemp, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import {
  CLAUDE_GATEWAY_MODEL_CACHE_RELPATH,
  claudeGatewayModelCache,
} from "./launch-env.js";

/**
 * 이 SDK 인스턴스가 소유하는 격리 `CLAUDE_CONFIG_DIR`.
 *
 * 격리는 옵션이 아니라 불변식이다. 사용자의 실제 `~/.claude`를 쓰면 (1) Fleet Console이 agent를
 * 띄울 때마다 같은 `cache/gateway-models.json`을 자기 port로 다시 써서 `baseUrl` 한 필드를 두고
 * 경합하고, (2) 사용자의 `CLAUDE.md`·settings·plugins·custom agents가 자식에게 딸려 들어와
 * "커스텀 시스템 프롬프트와 커스텀 에이전트를 주입하지 않는다"는 계약이 무너진다. 격리는 그 계약을
 * 약속이 아니라 구조로 만든다.
 */
export interface IsolatedClaudeConfigDir {
  readonly path: string;
  /** discovery 캐시를 현재 baseUrl과 모델 목록으로 다시 쓴다. */
  writeModelCache(options: {
    readonly baseUrl: string;
    readonly models: readonly GatewayModel[];
    readonly fetchedAt: number;
  }): Promise<void>;
  dispose(): Promise<void>;
}

export async function createIsolatedClaudeConfigDir(
  tempRoot: string = tmpdir(),
): Promise<IsolatedClaudeConfigDir> {
  const root = await mkdtemp(path.join(tempRoot, "core-agent-claude-"));
  const cachePath = path.join(root, CLAUDE_GATEWAY_MODEL_CACHE_RELPATH);
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });

  let disposed = false;
  return {
    path: root,
    async writeModelCache(options): Promise<void> {
      if (disposed) throw new Error("The isolated Claude config directory has been disposed.");
      const body = JSON.stringify(claudeGatewayModelCache(options));
      // 자식이 반쯤 쓰인 캐시를 읽으면 모델 검증이 알 수 없는 이유로 실패한다. 같은 디렉터리에
      // 쓰고 rename해서 교체를 원자적으로 만든다.
      const staging = `${cachePath}.tmp`;
      await writeFile(staging, body, { mode: 0o600 });
      await rename(staging, cachePath);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}
