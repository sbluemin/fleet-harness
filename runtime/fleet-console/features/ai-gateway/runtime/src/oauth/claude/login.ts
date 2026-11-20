import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceAuthorization, DevicePollResult } from "../device-code.js";
import { createLoginSessions, type LoginFlow, type LoginStart, type LoginStatus } from "../login-sessions.js";

/** 이 로그인 흐름의 공급자 이름. 세션 키이자 Gateway 마운트(`ai-gateway/oauth/claude`)의 조각이다. */
export const CLAUDE_LOGIN_PROVIDER = "claude";

/** 승인을 기다리는 제한시간. 다른 공급자의 `expiresAt`처럼 이 시간이 지나면 자식에게 SIGINT를 보낸다. */
export const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 자식이 `visit:` 줄을 내놓을 때까지 기다리는 시간. 넘으면 시작 실패다. */
const URL_WAIT_MS = 15_000;
/** `auth status --json` 한 번에 허용하는 시간. */
const STATUS_TIMEOUT_MS = 15_000;
/** SIGINT 뒤에도 남아 있는 자식을 끝내기까지의 유예. */
const KILL_GRACE_MS = 5_000;
/** 한 번에 붙여 넣을 수 있는 코드의 길이 상한. */
const CODE_MAX_LENGTH = 2_048;
const OUTPUT_MAX_CHARS = 64 * 1024;

/** 자식 CLI를 띄우는 포트. stdin·stdout·stderr가 모두 pipe인 Node 자식을 돌려줘야 한다(`ClaudeProcessSpawner`와 같은 모양). */
export type ClaudeLoginSpawner = (request: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}) => ChildProcess;

export interface ClaudeCliLoginDeps {
  /** 사령관과 같은 리졸버가 찾은 CLI, 없으면 SDK 동봉 바이너리. 둘 다 없으면 undefined. */
  readonly resolveExecutable: () => Promise<string | undefined> | string | undefined;
  readonly spawn: ClaudeLoginSpawner;
  /** 상속 환경. 기본은 `process.env`. */
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** 자식이 로그인 페이지 주소를 내놓을 때까지 기다리는 시간. 기본 15초. */
  readonly urlWaitMs?: number;
  /** 로그인이 끝나 `loggedIn`이 확인된 직후. 사용량을 곧바로 다시 읽는 자리다. */
  readonly onSignedIn?: () => void;
}

/**
 * `claude auth login`을 돌릴 환경. 사용자 기본 환경 그대로다 — `CLAUDE_CONFIG_DIR`·`CLAUDE_SECURESTORAGE_CONFIG_DIR`를
 * 세우지 않는다. 세우면 Claude Code가 접미사가 붙은 Keychain 항목에 저장해 Quota·사령관·구성원이 같은 로그인을 못 본다.
 * 호출한 환경이 가진 자격 변수(`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`)는 지운다 — 남아 있으면 `auth status`가
 * 방금 한 로그인이 아니라 그 값을 보고 로그인됨이라고 답한다.
 */
export function claudeLoginEnv(inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    env[key] = value;
  }
  return env;
}

// OSC(`ESC ] … BEL` 또는 `ESC ] … ESC \`) — 하이퍼링크(OSC 8)가 이것이다. 안쪽의 보이는 글자만 남긴다.
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC8_HREF_AFTER_VISIT = /visit:\s*\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/;
const ANTHROPIC_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];

/** 로그인 페이지는 Anthropic의 https 주소여야 한다. 다른 호스트로 사용자를 보내지 않는다. */
function loginPageUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    return ANTHROPIC_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? url.href : undefined;
  } catch { return undefined; }
}

/** stdout에서 `visit:` 뒤의 URL을 꺼낸다. 터미널 하이퍼링크 시퀀스는 걷는다. 없으면 undefined. */
export function extractClaudeLoginUrl(output: string): string | undefined {
  const plain = output.replace(OSC, "").replace(CSI, "");
  const visible = /visit:\s*(https:\/\/[^\s\u0007\u001b]+)/.exec(plain)?.[1];
  return loginPageUrl(visible) ?? loginPageUrl(OSC8_HREF_AFTER_VISIT.exec(output)?.[1]);
}

/** `claude auth status --json`의 loggedIn. 종료 코드는 보지 않는다(미로그인이면 1을 내면서 JSON을 쓴다). */
export function parseClaudeAuthStatus(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true;
  } catch { return false; }
}

/** 붙여 넣을 코드의 모양(`code#state`). CLI도 같은 규칙으로 되돌려 보낸다. 줄바꿈·공백은 stdin 한 줄을 깨므로 받지 않는다. */
export function isClaudeLoginCode(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length <= CODE_MAX_LENGTH && /^[^\s\u0000-\u001f\u007f#]+#[^\s\u0000-\u001f\u007f#]+$/.test(value);
}

interface CliRun {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  exitCode: number | null | undefined;
}

class ClaudeLoginFlow implements LoginFlow {
  loginId: string | undefined;
  run: CliRun | undefined;

  constructor(private readonly deps: ClaudeCliLoginDeps, private readonly timeoutMs: number, private readonly now: () => number) {}

  async start(signal: AbortSignal): Promise<DeviceAuthorization> {
    const command = await this.deps.resolveExecutable();
    if (command === undefined) throw new Error("Claude CLI not found");
    signal.throwIfAborted();
    const env = claudeLoginEnv(this.deps.env?.() ?? process.env);
    const child = this.deps.spawn({ command, args: ["auth", "login"], env });
    const run: CliRun = {
      child, exitCode: undefined,
      exited: new Promise<number | null>((resolve) => {
        child.once("exit", (code) => { run.exitCode = code; resolve(code); });
        child.once("error", () => { run.exitCode = null; resolve(null); });
      }),
    };
    this.run = run;
    // 끝까지 읽어야 pipe가 차지 않는다. 출력 원문은 URL을 뽑는 데만 쓰고 어디에도 남기지 않는다.
    child.stderr?.on("data", () => undefined);
    child.stdin?.on("error", () => undefined);
    signal.addEventListener("abort", () => this.stop(), { once: true });
    const url = await this.waitForUrl(run, signal);
    return {
      deviceCode: "", userCode: "", verificationUri: url,
      expiresAt: this.now() + this.timeoutMs, interval: 1,
    };
  }

  private waitForUrl(run: CliRun, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let output = "";
      const finish = (action: () => void) => {
        clearTimeout(timer);
        run.child.stdout?.off("data", onData);
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onData = (chunk: Buffer | string) => {
        output = (output + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
        const url = extractClaudeLoginUrl(output);
        // 이 이후의 출력(붙여넣기 안내 등)은 읽지 않고 흘려보낸다 — pipe가 차지 않도록 리스너만 남긴다.
        if (url !== undefined) finish(() => { run.child.stdout?.on("data", () => undefined); resolve(url); });
      };
      const onAbort = () => finish(() => reject(new Error("aborted")));
      const timer = setTimeout(() => finish(() => { this.stop(); reject(new Error("Claude login URL not shown")); }), this.deps.urlWaitMs ?? URL_WAIT_MS);
      timer.unref?.();
      run.child.stdout?.on("data", onData);
      void run.exited.then(() => finish(() => reject(new Error("Claude CLI exited before showing a login page"))));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 취소·시간 끝남·종료. SIGINT로 CLI가 스스로 정리하게 하고, 그래도 남으면 끝낸다. */
  stop(): void {
    const run = this.run;
    if (run === undefined || run.exitCode !== undefined) return;
    try { run.child.kill("SIGINT"); } catch { /* 이미 끝난 자식이다. */ }
    const timer = setTimeout(() => {
      if (run.exitCode === undefined) { try { run.child.kill("SIGKILL"); } catch { /* 이미 끝났다. */ } }
    }, KILL_GRACE_MS);
    timer.unref?.();
    void run.exited.then(() => clearTimeout(timer));
  }

  /** 받은 코드를 CLI stdin에 `코드\n`으로 쓴다. 코드는 기록하지 않는다. */
  write(code: string): boolean {
    const stdin = this.run?.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable || this.run?.exitCode !== undefined) return false;
    stdin.write(`${code}\n`);
    return true;
  }

  async pollOnce(_authorization: DeviceAuthorization, signal: AbortSignal): Promise<DevicePollResult> {
    const run = this.run;
    if (!run) throw new Error("Claude login not started");
    // 끝났으면 곧바로, 아니면 한 번 기다린 뒤 아직 진행 중이라고 답한다.
    const code = await Promise.race([run.exited, delay(1_000, "pending" as const, { signal })]);
    if (code === "pending") return { state: "pending" };
    if (code !== 0) throw new Error("Claude login failed");
    return { state: "authorized", accessToken: "" };
  }

  async authorized(_token: Extract<DevicePollResult, { state: "authorized" }>, signal: AbortSignal): Promise<LoginStatus> {
    const loggedIn = await this.readLoggedIn(signal);
    if (!loggedIn) return { state: "failed", message: "Sign-in failed. Please try again." };
    this.deps.onSignedIn?.();
    return { state: "signed_in" };
  }

  private async readLoggedIn(signal: AbortSignal): Promise<boolean> {
    const command = await this.deps.resolveExecutable();
    if (command === undefined) return false;
    const child = this.deps.spawn({ command, args: ["auth", "status", "--json"], env: claudeLoginEnv(this.deps.env?.() ?? process.env) });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout = (stdout + chunk.toString()).slice(0, OUTPUT_MAX_CHARS); });
    child.stderr?.on("data", () => undefined);
    child.stdin?.end();
    const timeout = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 끝났다. */ } }, STATUS_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* 이미 끝났다. */ } };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("error", () => resolve());
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
    return parseClaudeAuthStatus(stdout);
  }
}

export type ClaudePasteResult = "accepted" | "not_found" | "not_pending" | "invalid_code";

/**
 * Claude Code 로그인(`claude auth login`) 어댑터. Console이 자격을 쓰지 않는다 — CLI가 사용자 기본 환경에 저장하고,
 * 이 모듈은 로그인 페이지 주소를 건네고, 코드를 stdin에 전달하고, 끝난 뒤 `auth status --json`의 `loggedIn`으로 확인한다.
 * CLI가 호스트 브라우저를 스스로 여는 것은 막지 않는다. 로그아웃은 두지 않는다(터미널 로그인까지 끊기기 때문).
 */
export function createClaudeCliLogin(deps: ClaudeCliLoginDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS;
  const sessions = createLoginSessions({ now });
  const flows = new Map<string, ClaudeLoginFlow>();
  const cleanup = (loginId: string) => { if (sessions.status(loginId)?.state !== "pending") flows.delete(loginId); };
  return {
    async start(): Promise<LoginStart> {
      const flow = new ClaudeLoginFlow(deps, timeoutMs, now);
      const started = await sessions.start(CLAUDE_LOGIN_PROVIDER, flow);
      // 진행 중인 로그인이 있으면 그 시작 결과가 돌아오고 새 흐름은 자식을 띄우지 않았다.
      if (flow.run !== undefined && !flows.has(started.loginId)) {
        flow.loginId = started.loginId;
        flows.set(started.loginId, flow);
      }
      return started;
    },
    status(loginId: string): LoginStatus | undefined {
      const status = sessions.status(loginId);
      if (status && status.state !== "pending") flows.delete(loginId);
      return status;
    },
    cancel(loginId: string): LoginStatus | undefined {
      const status = sessions.cancel(loginId);
      cleanup(loginId);
      return status;
    },
    /** 원격 기기에서 받은 코드를 진행 중인 로그인에 전한다. */
    paste(loginId: string, code: unknown): ClaudePasteResult {
      const status = sessions.status(loginId);
      if (status === undefined) return "not_found";
      const flow = flows.get(loginId);
      if (status.state !== "pending" || flow === undefined) return "not_pending";
      if (!isClaudeLoginCode(code)) return "invalid_code";
      return flow.write(code) ? "accepted" : "not_pending";
    },
    dispose(): void {
      for (const flow of flows.values()) flow.stop();
      flows.clear();
      sessions.dispose();
    },
  };
}

export type ClaudeCliLogin = ReturnType<typeof createClaudeCliLogin>;
