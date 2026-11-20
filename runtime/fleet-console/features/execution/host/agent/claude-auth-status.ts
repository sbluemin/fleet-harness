import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withHidden } from "@fleet-console/process";

import { chatChildEnv } from "../terminal/launch-env.js";

/**
 * 사령관 채팅이 답할 수 있는지 — 설치된 CLI와 *같은 실행 환경*에서 Claude 로그인을 읽기 전용으로 확인한다.
 *
 * 채팅 자식은 격리 `CLAUDE_CONFIG_DIR`과 `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`으로 뜬다. 그래서 사용자의 실제
 * config dir를 건드리지 않고 같은 모양(빈 config dir + 접미사 없는 기본 keychain)으로 `claude auth status --json`을
 * 돌린다. 자격 증명은 읽기만 하고 쓰지 않는다.
 *
 * 판정 실패(시간 초과·해석 불가)는 `ready`다 — 보내기를 막으려면 근거가 있어야 하고, CLI가 정말 미로그인이라면
 * 보낸 뒤 턴 실패가 원인 카드로 이어진다.
 */
export type ClaudeAuthProbeResult = "ready" | "signedout";

export interface ClaudeAuthProbeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /**
   * 이미 있는 공유 `CLAUDE_CONFIG_DIR`을 그대로 읽기 전용으로 확인한다(지휘관 채팅 경로).
   * 주면 임시 폴더를 만들거나 지우지 않고, 자식 환경의 secure-storage 선택도 그대로 둔다.
   */
  readonly configDir?: string;
  /** 판정용 빈 config dir. 테스트가 실제 임시 폴더를 피하려고 갈아 끼운다. */
  readonly createConfigDir?: () => Promise<string>;
  readonly removeConfigDir?: (dir: string) => Promise<void>;
  /** `auth status --json` 실행. 종료 코드 1(미로그인)도 stdout과 함께 돌려준다. */
  readonly run?: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ readonly stdout: string }>;
}

const AUTH_PROBE_TIMEOUT_MS = 5_000;

export async function probeClaudeAuth(binary: string, deps: ClaudeAuthProbeDeps = {}): Promise<ClaudeAuthProbeResult> {
  const createConfigDir = deps.createConfigDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "fleet-claude-auth-")));
  const removeConfigDir = deps.removeConfigDir ?? ((dir) => fs.rm(dir, { recursive: true, force: true }));
  const run = deps.run ?? ((bin, args, env) => runAuthStatus(bin, args, env, deps.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS));
  const shared = deps.configDir !== undefined;
  let tempConfigDir: string | undefined;
  try {
    const configDir = shared ? deps.configDir! : (tempConfigDir = await createConfigDir());
    const env = authProbeEnv(deps.env ?? process.env, configDir, shared);
    const { stdout } = await run(binary, ["auth", "status", "--json"], env);
    const loggedIn = loggedInOf(stdout);
    return loggedIn === false ? "signedout" : "ready";
  } catch {
    return "ready";
  } finally {
    if (tempConfigDir !== undefined) await removeConfigDir(tempConfigDir).catch(() => undefined);
  }
}

/** 채팅 자식과 같은 상속 정리. 사령관(격리)은 빈 config dir + 기본 keychain, 지휘관(공유)은 공유 config dir을 그대로 쓴다. */
export function authProbeEnv(inherited: NodeJS.ProcessEnv, configDir: string, shared = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = shared
    ? { ...chatChildEnv(inherited), CLAUDE_CONFIG_DIR: configDir }
    : { ...chatChildEnv(inherited), CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" };
  // 채팅 자식의 launch env도 이 셋을 지운다 — 상속된 키·모델이 로그인 판정을 바꾸지 않게 같은 자리를 비운다.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_MODEL;
  return env;
}

/** `{"loggedIn": false, ...}`만 읽는다. 종료 코드는 보지 않는다 — 미로그인의 정상 신호가 1이다. */
function loggedInOf(stdout: string): boolean | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const loggedIn = (parsed as { readonly loggedIn?: unknown }).loggedIn;
    return typeof loggedIn === "boolean" ? loggedIn : null;
  } catch {
    return null;
  }
}

function runAuthStatus(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], withHidden({ env, encoding: "utf-8" as const, timeout: timeoutMs, maxBuffer: 1 << 20 }), (error, stdout) => {
      // 로그인 안 됨은 종료 코드 1과 함께 정상 JSON을 낸다 — JSON이 있으면 오류로 보지 않는다.
      if (stdout.trim().length > 0) { resolve({ stdout }); return; }
      if (error) { reject(error); return; }
      resolve({ stdout });
    });
  });
}
