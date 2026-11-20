import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeCliLogin } from "@fleet-console/ai-gateway";

import { resolveAgentCliBinary } from "../../features/execution/host/agent/agent-cli-paths.js";
import { probeClaudeAuth } from "../../features/execution/host/agent/claude-auth-status.js";

/**
 * console-e2e 공용 Claude 인증 fixture(`fake-claude.mjs`의 `auth` 분기)를 제품 로그인 어댑터와 실행 probe로 검증한다.
 *
 * 안전 경계: 실행기는 고정 Node + 저장소 fake 절대 경로 + 정확한 argv + 합성 allowlist 환경만 허용하고, 그 밖의 요청은
 * spawn 전에 거부한다. 브라우저 열기·Keychain·네트워크·모델·계정·동봉 CLI·배포 호스트의 resolver 폴백과 성공 뒤 Quota 갱신은
 * 이 시험이 호출하지 않는다(어댑터에 브라우저 의존성이 없고 `onSignedIn`은 메모리 콜백이다). 통과는 합성 상태에 대한
 * 어댑터·probe 반응이며 실제 인증이나 실제 CLI와의 동등성이 아니다.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAKE = path.join(repoRoot, ".claude/skills/console-e2e/scripts/fake-claude.mjs");
const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic-fixture&state=synthetic-fixture";
const CODE = "synthetic-code#synthetic-state";
const ENV_ALLOWLIST = new Set(["FAKE_CLAUDE_DIR", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_ARTIFACT", "FAKE_CLAUDE_AUTH_MODE"]);
const roots: string[] = [];
const children: ChildProcess[] = [];
// probe는 판정 실패를 ready로 흘린다(fail-open) — 가드 거부가 ready로 위장하지 않게 따로 센다.
const probeRejected: string[] = [];

interface Slot { readonly root: string; readonly dir: string }
function slot(): Slot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-fixture-"));
  roots.push(root);
  const dir = path.join(root, "fake");
  fs.mkdirSync(dir);
  return { root, dir };
}
const setMode = (s: Slot, mode: string) => fs.writeFileSync(path.join(s.dir, "auth-mode"), `${mode}\n`);
const logOf = (s: Slot) => {
  try {
    return fs.readFileSync(path.join(s.dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; argv?: string; signal?: string; reason?: string });
  } catch { return []; }
};
const launches = (s: Slot) => logOf(s).filter((entry) => entry.event === "auth-launch").map((entry) => entry.argv);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exitedAll = () => children.every((child) => child.exitCode !== null || child.signalCode !== null);

/** 허용 요청: command가 fake 절대 경로이고 argv가 정확히 `auth login` 또는 `auth status --json`이며 env 키가 allowlist 안. */
function checkRequest(command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): void {
  if (command !== FAKE) throw new Error(`rejected command: ${command}`);
  const exact = (expected: readonly string[]) => args.length === expected.length && expected.every((token, index) => args[index] === token);
  if (!exact(["auth", "login"]) && !exact(["auth", "status", "--json"])) throw new Error(`rejected argv: ${args.join(" ")}`);
  const extra = Object.keys(env).filter((key) => env[key] !== undefined && !ENV_ALLOWLIST.has(key));
  if (extra.length > 0) throw new Error(`rejected env keys: ${extra.join(",")}`);
}
const cleanEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function harness(s: Slot, options: { resolve?: () => string | undefined; urlWaitMs?: number; timeoutMs?: number } = {}) {
  const spawned: string[] = [];
  const rejected: string[] = [];
  const signedIn: string[] = [];
  const baseEnv = { FAKE_CLAUDE_AUTH_MODE: "success", FAKE_CLAUDE_DIR: s.dir, HOME: path.join(s.root, "home"), TMPDIR: s.root };
  const login = createClaudeCliLogin({
    resolveExecutable: options.resolve ?? (() => FAKE),
    spawn: (request) => {
      try { checkRequest(request.command, request.args, request.env); } catch (error) { rejected.push(String(error)); throw error; }
      spawned.push(request.args.join(" "));
      const child = spawn(process.execPath, [FAKE, ...request.args], { env: cleanEnv(request.env), stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
    // 자격 변수는 일부러 넣는다 — 어댑터가 두 자식 모두에서 지워 allowlist를 통과해야 한다.
    env: () => ({ ...baseEnv, ANTHROPIC_API_KEY: "synthetic", CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }),
    onSignedIn: () => { signedIn.push("signed_in"); },
    ...(options.urlWaitMs === undefined ? {} : { urlWaitMs: options.urlWaitMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { login, spawned, rejected, signedIn };
}

/** 실행 probe(`probeClaudeAuth`)를 같은 가드 실행기로 돌린다. 반환: ready | signedout. */
function probe(s: Slot) {
  return probeClaudeAuth(FAKE, {
    env: { FAKE_CLAUDE_AUTH_MODE: "success", FAKE_CLAUDE_DIR: s.dir, HOME: path.join(s.root, "home"), TMPDIR: s.root },
    createConfigDir: async () => path.join(s.root, "probe-config"),
    removeConfigDir: async () => undefined,
    run: (bin, args, env) => new Promise((resolve, reject) => {
      try { checkRequest(bin, args, env); } catch (error) { probeRejected.push(String(error)); reject(error); return; }
      execFile(process.execPath, [FAKE, ...args], { env: cleanEnv(env), encoding: "utf-8" }, (error, stdout) => {
        if (stdout.trim().length > 0) resolve({ stdout }); else reject(error ?? new Error("no output"));
      });
    }),
  });
}

async function finish(h: ReturnType<typeof harness>) {
  h.login.dispose();
  await expect.poll(exitedAll, { timeout: 8000 }).toBe(true);
}

afterEach(() => {
  // 정리가 먼저다 — 아래 단언이 실패해도 자식과 임시 폴더는 남지 않는다.
  try {
    for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* 이미 끝났다. */ } }
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  } finally {
    expect(probeRejected.splice(0)).toEqual([]);
  }
});

describe.skipIf(process.platform === "win32")("console-e2e Claude auth fixture", () => {
  it("starts signed out and reads as signedout through the execution probe", async () => {
    const s = slot();
    expect(await probe(s)).toBe("signedout");
    expect(launches(s)).toEqual(["auth status --json"]);
    expect(fs.existsSync(path.join(s.dir, "auth-state.json"))).toBe(false);
  });

  it("signs in only after a code-shaped input and fake auth status, calling the in-memory callback once", async () => {
    const s = slot();
    const h = harness(s);
    try {
      const started = await h.login.start();
      expect(started.verificationUri).toBe(LOGIN_URL);
      expect(h.login.status(started.loginId)).toEqual({ state: "pending" });
      expect(await probe(s)).toBe("signedout"); // 입력 전에는 상태가 그대로다.
      expect(h.login.paste(started.loginId, CODE)).toBe("accepted");
      await expect.poll(() => h.login.status(started.loginId)?.state, { timeout: 8000 }).toBe("signed_in");
      expect(h.signedIn).toEqual(["signed_in"]);
      expect(h.spawned).toEqual(["auth login", "auth status --json"]);
      expect(await probe(s)).toBe("ready");
      // 입력 값은 어디에도 남지 않는다 — 수신 여부만 기록한다.
      for (const name of fs.readdirSync(s.dir)) expect(fs.readFileSync(path.join(s.dir, name), "utf8")).not.toContain(CODE);
      expect(logOf(s).filter((entry) => entry.event === "auth-input")).toEqual([expect.objectContaining({ shape: "ok" })]);
      expect(h.rejected).toEqual([]);
    } finally { await finish(h); }
  });

  it.each(["fail", "unconfirmed"])("never signs in or calls back in %s mode", async (mode) => {
    const s = slot();
    setMode(s, mode);
    const h = harness(s);
    try {
      const started = await h.login.start();
      expect(h.login.paste(started.loginId, CODE)).toBe("accepted");
      await expect.poll(() => h.login.status(started.loginId)?.state, { timeout: 8000 }).toBe("failed");
      expect(h.signedIn).toEqual([]);
      expect(await probe(s)).toBe("signedout");
    } finally { await finish(h); }
  });

  it("stays pending before any input without touching the state", async () => {
    const s = slot();
    const h = harness(s);
    try {
      const started = await h.login.start();
      await wait(1500);
      expect(h.login.status(started.loginId)).toEqual({ state: "pending" });
      expect(h.signedIn).toEqual([]);
      expect(launches(s)).toEqual(["auth login"]);
      expect(fs.existsSync(path.join(s.dir, "auth-state.json"))).toBe(false);
    } finally { await finish(h); }
  });

  it("ends the login with SIGINT on cancel and makes no success follow-up call", async () => {
    const s = slot();
    const h = harness(s);
    try {
      const started = await h.login.start();
      expect(h.login.cancel(started.loginId)).toEqual({ state: "cancelled" });
      await expect.poll(() => logOf(s).some((entry) => entry.event === "auth-signal" && entry.signal === "SIGINT"), { timeout: 8000 }).toBe(true);
      await wait(1500);
      expect(h.login.status(started.loginId)).toEqual({ state: "cancelled" });
      expect(h.signedIn).toEqual([]);
      expect(h.spawned).toEqual(["auth login"]);
      expect(await probe(s)).toBe("signedout");
    } finally { await finish(h); }
  });

  it("refuses to start when the fixture shows no login page, then ends the child", async () => {
    const s = slot();
    setMode(s, "no-url");
    const h = harness(s, { urlWaitMs: 400 });
    try {
      await expect(h.login.start()).rejects.toThrow(/Unable to start sign-in/);
      await expect.poll(() => logOf(s).some((entry) => entry.event === "auth-signal"), { timeout: 8000 }).toBe(true);
      expect(h.signedIn).toEqual([]);
    } finally { await finish(h); }
  });

  it("keeps two owned directories independent and leaves nothing after cleanup", async () => {
    const a = slot();
    const b = slot();
    const ha = harness(a);
    try {
      const started = await ha.login.start();
      expect(ha.login.paste(started.loginId, CODE)).toBe("accepted");
      await expect.poll(() => ha.login.status(started.loginId)?.state, { timeout: 8000 }).toBe("signed_in");
      expect(await probe(a)).toBe("ready");
      expect(await probe(b)).toBe("signedout");
      expect(fs.existsSync(path.join(b.dir, "auth-state.json"))).toBe(false);
      expect(launches(b)).toEqual(["auth status --json"]);
    } finally { await finish(ha); }
    for (const owned of [a, b]) fs.rmSync(owned.root, { recursive: true, force: true });
    expect([a, b].map((owned) => fs.existsSync(owned.root))).toEqual([false, false]);
    expect(exitedAll()).toBe(true);
    // 새 목표 디렉터리는 다시 미로그인에서 시작한다.
    const c = slot();
    expect(await probe(c)).toBe("signedout");
  });

  it("does not spawn when an injected resolver finds nothing, or when the executor rejects the request", async () => {
    const none = harness(slot(), { resolve: () => undefined });
    await expect(none.login.start()).rejects.toThrow(/Unable to start sign-in/);
    expect(none.spawned).toEqual([]);
    none.login.dispose();

    const other = harness(slot(), { resolve: () => "/bin/sh" });
    await expect(other.login.start()).rejects.toThrow(/Unable to start sign-in/);
    expect(other.rejected).toEqual(["Error: rejected command: /bin/sh"]);
    expect(other.spawned).toEqual([]);
    expect(children).toHaveLength(0);
    other.login.dispose();

    expect(() => checkRequest(FAKE, ["auth", "logout"], {})).toThrow(/rejected argv/);
    expect(() => checkRequest(FAKE, ["auth", "status --json"], {})).toThrow(/rejected argv/);
    expect(() => checkRequest(FAKE, ["auth", "login"], { PATH: "/usr/bin" })).toThrow(/rejected env/);
  });

  it("rejects other argv, unowned directories and symlink escapes before creating or logging anything", async () => {
    const run = (args: string[], env: Record<string, string>) => new Promise<number>((resolve) => {
      execFile(process.execPath, [FAKE, ...args], { env: { FAKE_CLAUDE_AUTH_MODE: "success", ...env } }, (error) => resolve(typeof error?.code === "number" ? error.code : 0));
    });
    const s = slot();
    expect(await run(["auth", "logout"], { FAKE_CLAUDE_DIR: s.dir })).toBe(2);
    expect(await run(["auth", "status --json"], { FAKE_CLAUDE_DIR: s.dir })).toBe(2);
    expect(await run(["auth", "status", "--json", "--version"], { FAKE_CLAUDE_DIR: s.dir })).toBe(2);
    expect(logOf(s).map((entry) => entry.reason)).toEqual(["argv", "argv", "argv"]);
    setMode(s, "bogus");
    expect(await run(["auth", "login"], { FAKE_CLAUDE_DIR: s.dir })).toBe(2);
    expect(JSON.stringify(logOf(s))).not.toMatch(/bogus|logout/);

    // 보호 경로는 가짜 홈(HOME 재지정)으로 만든다 — 사용자의 실제 파일은 읽지도 만들지도 않는다.
    const home = path.join(s.root, "fake-home");
    fs.mkdirSync(home);
    const snapshot = () => fs.readdirSync(s.root, { recursive: true }).map(String).sort();
    const before = snapshot();
    const inHome = (dir: string) => run(["auth", "status", "--json"], { FAKE_CLAUDE_DIR: dir, HOME: home });
    expect(await inHome(home)).toBe(2);
    expect(await inHome(s.root)).toBe(2); // 홈의 조상
    expect(await inHome(path.join(home, ".claude", "probe"))).toBe(2);
    expect(await inHome(path.join(home, ".config", "probe"))).toBe(2);
    expect(await run(["auth", "status", "--json"], { FAKE_CLAUDE_DIR: "relative-dir", HOME: home })).toBe(2);
    // 실제 계정 홈은 경로만 넘긴다(존재를 단정하지도 쓰지도 않는다) — HOME을 가짜로 바꿔도 두 번째 검사가 막는다.
    expect(await inHome(os.userInfo().homedir)).toBe(2);
    // 경로 중간 심볼릭 링크: 소유 슬롯 안의 링크가 보호 경로를 가리켜도 실제 경로로 거부한다.
    const hop = path.join(s.root, "hop");
    fs.symlinkSync(home, hop);
    expect(await inHome(path.join(hop, ".claude", "probe"))).toBe(2);
    expect(await inHome(path.join(hop, ".config", "deep", "probe"))).toBe(2);
    expect(await inHome(hop)).toBe(2);
    expect(snapshot()).toEqual([...before, "hop"].sort());
    expect(fs.readdirSync(home)).toEqual([]);

    // 링크인 디렉터리·상태 파일은 따라가지 않는다.
    const target = slot();
    const link = path.join(s.root, "link");
    fs.symlinkSync(target.dir, link);
    expect(await run(["auth", "status", "--json"], { FAKE_CLAUDE_DIR: link })).toBe(2);
    fs.symlinkSync(path.join(target.dir, "elsewhere"), path.join(s.dir, "auth-state.json"));
    expect(await run(["auth", "status", "--json"], { FAKE_CLAUDE_DIR: s.dir })).toBe(2);
    expect(fs.readdirSync(target.dir)).toEqual([]);
  });

  it("keeps the existing fake behavior for `auth` argv unless FAKE_CLAUDE_AUTH_MODE opts in", async () => {
    const s = slot();
    const child = spawn(process.execPath, [FAKE, "auth", "status", "--json"], { env: { FAKE_CLAUDE_DIR: s.dir }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    await expect.poll(() => stdout, { timeout: 8000 }).toContain("fake-claude terminal session=");
    child.kill("SIGTERM");
    await expect.poll(exitedAll, { timeout: 8000 }).toBe(true);
    // 인증 분기가 아니다: loggedIn 응답도, 인증 상태 파일도, auth-* 로그도 없다. 기존 터미널 경로의 launch 로그만 남는다.
    expect(stdout).not.toContain("loggedIn");
    expect(fs.existsSync(path.join(s.dir, "auth-state.json"))).toBe(false);
    expect(logOf(s).map((entry) => entry.event).filter((event) => event.startsWith("auth-"))).toEqual([]);
    expect(logOf(s)[0]).toMatchObject({ event: "launch", mode: "terminal" });
    // 빈 모드는 opt-in이 아니다.
    const empty = await new Promise<string>((resolve) => {
      const probeChild = spawn(process.execPath, [FAKE, "auth", "status", "--json"], { env: { FAKE_CLAUDE_DIR: s.dir, FAKE_CLAUDE_AUTH_MODE: "" }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(probeChild);
      let out = "";
      probeChild.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); if (out.includes("terminal session")) { probeChild.kill("SIGTERM"); resolve(out); } });
    });
    expect(empty).not.toContain("loggedIn");
    await expect.poll(exitedAll, { timeout: 8000 }).toBe(true);
  });

  it("keeps --version on the non-auth path", async () => {
    const version = await new Promise<string>((resolve) => execFile(process.execPath, [FAKE, "--version"], { env: {} }, (_error, stdout) => resolve(stdout)));
    expect(version).toBe("2.1.999 (Claude Code)\n");
  });

  it("reports a missing CLI from the product resolver, and keeps the probe fail-open when it cannot run", async () => {
    const s = slot();
    const emptyPath = path.join(s.root, "empty-path");
    fs.mkdirSync(emptyPath);
    // execution.ts의 resolveClaudeExecutable과 같은 입력·매핑: CLAUDE_BIN 없음, 빈 소유 PATH·가짜 홈, 사용자 지정 경로 없음.
    const resolution = resolveAgentCliBinary({ cliCommand: "claude", env: { PATH: emptyPath, HOME: path.join(s.root, "home") }, userPaths: {}, platform: process.platform });
    expect(resolution).toMatchObject({ resolved: undefined, source: null, error: null, searchedPathEntries: [emptyPath] });
    const executable = resolution.resolved && resolution.resolved.prefixArgs.length === 0 ? resolution.resolved.bin : undefined;
    expect(executable).toBeUndefined(); // readCliStatus는 이 입력에서 { status: "missing" }을 돌려준다.
    // 아래 ready는 `missing`이 아니다 — 존재하지 않는 경로를 probe에 직접 준 것이고, 실행 오류(ENOENT)를 ready로 흘리는 probe의 fail-open이다.
    const absent = path.join(s.root, "no-such-claude");
    expect(fs.existsSync(absent)).toBe(false);
    expect(await probeClaudeAuth(absent, { env: {}, createConfigDir: async () => path.join(s.root, "probe-config"), removeConfigDir: async () => undefined })).toBe("ready");
  });
});
