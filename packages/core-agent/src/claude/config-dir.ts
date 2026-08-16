import { mkdtemp, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import {
  CLAUDE_GATEWAY_MODEL_CACHE_RELPATH,
  claudeGatewayModelCache,
} from "./launch-env.js";

/**
 * 자식이 쓸 `CLAUDE_CONFIG_DIR`. 두 정책이 있고, 무엇을 소유하느냐가 다르다.
 *
 * **격리 홈**은 이 인스턴스가 만들고 지운다. 캐시도 트랜스크립트도 그 안에서만 살아서, 이 SDK를
 * 쓰는 소비자는 사용자의 `~/.claude`에 아무 흔적을 남기지 않는다.
 *
 * **공유 홈**은 호스트가 이미 소유한 홈을 그대로 쓴다. 그 대가로 두 가지를 호스트가 책임진다.
 * (1) `cache/gateway-models.json`은 호스트 소유다 — 같은 홈을 쓰는 PTY 자식이 노출 모델 전체로
 * 쓴 캐시를 이 인스턴스가 자기 단일 모델로 덮으면 그 자식의 게이트웨이 별칭이 통째로 무효가 된다.
 * (2) 홈에 딸린 설정·플러그인 유출은 `settingSources: []`와 `strictMcpConfig`가 계속 막는다 —
 * 홈을 공유해도 자식이 읽는 지시는 여전히 호출자가 명시적으로 넘긴 것뿐이다.
 *
 * 공유 홈을 고르는 이유는 하나다: **트랜스크립트를 같은 자리에서 키우는 것**. 같은 세션을 PTY로
 * 열든 SDK로 열든 한 파일이 자라야 두 표면이 같은 세션의 두 얼굴이 된다. 격리 홈에서는 그것이
 * 복사·되쓰기 왕복으로만 흉내되고, 그 왕복은 원본을 덮어쓸 위험을 계속 안고 있었다.
 */
export interface ClaudeConfigHome {
  readonly path: string;
  /**
   * discovery 캐시를 현재 baseUrl과 모델 목록으로 다시 쓴다. 공유 홈에서는 아무것도 하지
   * 않는다 — 그 홈의 캐시는 호스트 것이다.
   */
  writeModelCache(options: {
    readonly baseUrl: string;
    readonly models: readonly GatewayModel[];
    readonly fetchedAt: number;
  }): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 호스트가 소유한 홈을 그대로 쓴다. 만들지도 지우지도 않고, 캐시도 건드리지 않는다.
 */
export function createSharedClaudeConfigHome(configDir: string): ClaudeConfigHome {
  // 상대 경로는 두 쪽이 서로 다른 기준으로 푼다: 자식은 자기 턴의 cwd에서, 이 프로세스는 자기
  // cwd에서. 그러면 자식이 트랜스크립트를 제대로 쓰고도 호출자는 그 파일을 못 찾아 좌표를 심지
  // 못하고, 재시작 뒤 그 세션은 "시작한 적 없음"으로 읽혀 다른 대화가 시작된다. 절대 경로만 받아
  // 그 어긋남을 생성 시점에 끝낸다.
  if (typeof configDir !== "string" || !path.isAbsolute(configDir)) {
    throw new TypeError("A shared Claude config home requires an absolute config directory path.");
  }
  return {
    path: configDir,
    async writeModelCache(): Promise<void> {
      // 호스트 소유. 여기서 쓰면 같은 홈의 PTY 자식이 읽는 목록을 이 인스턴스의 모델 하나로
      // 좁힌다 — 네이티브 별칭만 실린 인스턴스에서는 빈 목록이 되어 별칭이 전부 거절된다.
    },
    async dispose(): Promise<void> {
      // 우리가 만들지 않은 디렉터리는 우리가 지우지 않는다.
    },
  };
}

export async function createIsolatedClaudeConfigDir(
  tempRoot: string = tmpdir(),
): Promise<ClaudeConfigHome> {
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
