import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeLoginEnv, createClaudeCliLogin, extractClaudeLoginUrl } from "../src/oauth/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");
const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s";
const roots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-login-"));
  roots.push(root);
  return root;
}

function harness(extraEnv: Record<string, string> = {}, options: { timeoutMs?: number; urlWaitMs?: number } = {}) {
  const root = scratch();
  const log = path.join(root, "env.log");
  const stdinLog = path.join(root, "stdin.log");
  const signedIn: string[] = [];
  const login = createClaudeCliLogin({
    resolveExecutable: () => "fake-claude",
    spawn: (request) => spawn(process.execPath, [FIXTURE, ...request.args], { env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"] }),
    // 이 환경은 사용자의 것이 아니라 테스트의 것이다 — 자격 변수와 Console이 세우면 안 되는 홈 변수를 일부러 넣는다.
    env: () => ({
      PATH: process.env.PATH,
      HOME: root,
      ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://gateway", CLAUDE_CODE_OAUTH_TOKEN: "oat",
      FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STDIN_LOG: stdinLog, FAKE_CLAUDE_URL: LOGIN_URL,
      ...extraEnv,
    }),
    onSignedIn: () => { signedIn.push("signed_in"); },
    ...options,
  });
  return { login, log, stdinLog, signedIn };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Claude CLI sign-in adapter", () => {
  // 터미널·Keychain·승인 없이 실제 로그인의 수명 — URL 전달, 코드 stdin, loggedIn 확인, 종료 — 을 가짜 CLI로 실행한다.
  it("hands over the login page, writes the pasted code to stdin, and signs in only when loggedIn is confirmed", async () => {
    const test = harness({ FAKE_CLAUDE_LOGGED_IN: "1" });
    try {
      const started = await test.login.start();
      expect(started).toMatchObject({ verificationUri: LOGIN_URL, userCode: "" });
      expect(test.login.status(started.loginId)).toEqual({ state: "pending" });
      expect(test.login.paste(started.loginId, "no-separator")).toBe("invalid_code");
      expect(test.login.paste(started.loginId, "abc#def\nextra")).toBe("invalid_code");
      expect(test.login.paste("missing", "abc#def")).toBe("not_found");
      expect(test.login.paste(started.loginId, "abc#def")).toBe("accepted");
      await expect.poll(() => test.login.status(started.loginId)?.state, { timeout: 5000 }).toBe("signed_in");
      expect(fs.readFileSync(test.stdinLog, "utf8")).toBe("abc#def\n");
      expect(test.signedIn).toEqual(["signed_in"]);
      expect(test.login.paste(started.loginId, "abc#def")).toBe("not_pending");
      // 사용자 기본 환경: 홈 변수를 세우지 않고, 자격 변수는 두 자식(login·status) 모두에서 지운다.
      const seen = fs.readFileSync(test.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; keys: string[] });
      expect(seen.map((entry) => entry.args.join(" "))).toEqual(["auth login", "auth status --json"]);
      for (const entry of seen) {
        expect(entry.keys.filter((key) => key !== "HOME" && !key.startsWith("FAKE_"))).toEqual([]);
      }
    } finally { test.login.dispose(); }
  });

  it("fails on a non-zero exit and on exit 0 without loggedIn, never reporting a sign-in", async () => {
    for (const env of [{ FAKE_CLAUDE_FINAL: "1", FAKE_CLAUDE_LOGGED_IN: "1" }, { FAKE_CLAUDE_FINAL: "0", FAKE_CLAUDE_LOGGED_IN: "0" }]) {
      const test = harness(env);
      try {
        const started = await test.login.start();
        expect(test.login.paste(started.loginId, "abc#def")).toBe("accepted");
        await expect.poll(() => test.login.status(started.loginId)?.state, { timeout: 5000 }).toBe("failed");
        expect(test.signedIn).toEqual([]);
      } finally { test.login.dispose(); }
    }
  });

  it("ends the CLI with SIGINT on cancel and on timeout, without reading either as a sign-in", async () => {
    // 파이프로 받은 SIGINT는 종료 코드 0이다(2.1.329 실측) — 그래도 취소·시간 끝남이 성공으로 읽히면 안 된다.
    const cancelled = harness({ FAKE_CLAUDE_LOGGED_IN: "1" });
    try {
      const started = await cancelled.login.start();
      expect(cancelled.login.cancel(started.loginId)).toEqual({ state: "cancelled" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(cancelled.login.status(started.loginId)).toEqual({ state: "cancelled" });
      expect(cancelled.signedIn).toEqual([]);
      expect(fs.readFileSync(cancelled.log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally { cancelled.login.dispose(); }

    const timedOut = harness({ FAKE_CLAUDE_LOGGED_IN: "1" }, { timeoutMs: 300 });
    try {
      const started = await timedOut.login.start();
      await expect.poll(() => timedOut.login.status(started.loginId)?.state, { timeout: 3000 }).toBe("expired");
      expect(timedOut.signedIn).toEqual([]);
    } finally { timedOut.login.dispose(); }
  });

  it("refuses to start when the CLI never shows a login page, and keeps parsing the page out of terminal links", async () => {
    const test = harness({ FAKE_CLAUDE_NO_URL: "1" }, { urlWaitMs: 300 });
    try {
      await test.login.start().then(
        () => { throw new Error("expected start to fail"); },
        (error: unknown) => expect(String(error)).toMatch(/Unable to start sign-in/),
      );
    } finally { test.login.dispose(); }
    // 링크는 Anthropic의 https 페이지여야 한다.
    expect(extractClaudeLoginUrl(`visit: \u001b]8;;${LOGIN_URL}\u001b\\${LOGIN_URL}\u001b]8;;\u001b\\\n`)).toBe(LOGIN_URL);
    expect(extractClaudeLoginUrl(`visit: ${LOGIN_URL}\n`)).toBe(LOGIN_URL);
    expect(extractClaudeLoginUrl("visit: https://evil.example/login\n")).toBeUndefined();
    expect(extractClaudeLoginUrl("visit: http://claude.com/login\n")).toBeUndefined();
    expect(claudeLoginEnv({ ANTHROPIC_MODEL: "x", CLAUDE_CONFIG_DIR: "/home/.claude", KEEP: "1" })).toEqual({ CLAUDE_CONFIG_DIR: "/home/.claude", KEEP: "1" });
  });
});
