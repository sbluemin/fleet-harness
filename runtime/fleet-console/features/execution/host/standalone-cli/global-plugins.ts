import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";
import { withHidden, type OwnedChild, type OwnedProcessPort } from "@fleet-console/process";

/**
 * 독립 CLI에 함께 싣는 전역 플러그인 하나 — 사령관 플러그인 홈(`<consoleDataDir>/commodore-plugins`)에 받아 둔 설치본.
 * `name`은 Claude Code가 붙이는 플러그인 이름, `mcpServers`는 세션 MCP 선언(`plugin:<플러그인>:<서버>`),
 * `env`는 그 선언의 `${VAR}`에 채울, 사람이 Console에 넣은 키다.
 */
export interface StandaloneCliPlugin {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mcpServers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
  readonly env: Readonly<Record<string, string>>;
}

/** 전역 목록을 읽지 못해도 CLI는 뜬다 — 플러그인 없이. */
export function readStandaloneCliPlugins(read: (() => readonly StandaloneCliPlugin[]) | undefined): readonly StandaloneCliPlugin[] {
  if (!read) return [];
  try {
    return read();
  } catch (error) {
    console.warn(`[standalone-cli] global plugins unavailable: ${messageOf(error)}`);
    return [];
  }
}

/** 여러 플러그인의 키를 한 환경으로. 같은 이름은 먼저 실린 플러그인 쪽이다(사령관 세션과 같은 규칙). */
export function mergeStandaloneCliPluginEnv(plugins: readonly StandaloneCliPlugin[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const plugin of plugins) for (const [key, value] of Object.entries(plugin.env)) if (!(key in env)) env[key] = value;
  return env;
}

const AGY_PLUGIN_CLI_TIMEOUT_MS = 30_000;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(?::-([^}]*))?\}/g;
// agy 변환기가 설치본 루트에 남기는 JSON 중 절대 경로(`${CLAUDE_PLUGIN_ROOT}`를 펼친 값)를 품을 수 있는 것.
const ROOT_JSON_FILES = ["mcp_config.json", "hooks.json"] as const;

export interface AntigravityPluginInjection {
  readonly args: readonly string[];
  readonly cleanup: () => Promise<void>;
}

export interface AntigravityPluginOptions {
  readonly plugins: readonly StandaloneCliPlugin[];
  /** 독립 CLI가 띄울 그 `agy` — 변환도 같은 실행 파일에 맡긴다. */
  readonly bin: string;
  readonly prefixArgs: readonly string[];
  /** Fleet 내부 변수를 걷은 기반 환경. 변환 자식의 환경이자 키가 없는 `${VAR}`를 채울 자리다. */
  readonly env: NodeJS.ProcessEnv;
  /** 이미 다른 주입이 쓰는 플러그인 이름(예: `fleet-browser`). 같은 이름의 전역 플러그인은 싣지 않는다. */
  readonly reservedNames: readonly string[];
  /** 변환·목록 자식을 Console이 끝낼 수 있게 띄우는 소유 포트. 없으면(테스트·포트 없는 호스트) 평범한 자식이다. */
  readonly processes?: OwnedProcessPort;
  /** Console 종료 — 걸리면 진행 중인 변환 자식을 끝내고 남은 플러그인은 싣지 않는다. */
  readonly signal?: AbortSignal;
}

/**
 * 전역 플러그인을 Antigravity CLI(`agy`)의 세션 범위 플러그인으로 싣는다.
 *
 * agy는 Claude Code 플러그인을 그대로 읽지 못한다(`agy plugin validate`: "doesn't load as is"). 그래서 agy 자신의 변환기
 * (`agy plugin install <폴더>`)를 임시 HOME에서 돌려 사용자 `~/.gemini`를 건드리지 않고 변환본을 얻고, `--add-dir`로 넘길
 * 임시 폴더의 `.agents/plugins/<이름>`으로 옮긴다(agy 1.5.13 실측: 밖을 가리키는 심링크는 싣지 않으므로 실제 파일이어야 한다).
 *
 * - 변환기는 `${CLAUDE_PLUGIN_ROOT}`를 설치 위치의 절대 경로로 펼치므로 옮긴 위치로 고쳐 쓴다.
 * - agy MCP 설정은 환경 변수를 펼치지 않는다. 그래서 `${VAR}`는 사람이 넣은 키(없으면 기반 환경, 그다음 기본값)로 채워
 *   0600 파일에 쓴다 — `fleet-browser` Bearer 토큰과 같은 방식이며 argv에는 싣지 않는다.
 * - 사람이 agy에 직접 설치한 플러그인과 이름이 같으면 싣지 않는다. 세션 범위 사본이 같은 이름의 설치본을 가리기 때문이다
 *   (agy 1.5.13 실측) — 사람이 agy에서 로그인해 둔 MCP 서버를 로그인할 길이 없는 사본으로 덮지 않고, 그 사람의 것을 쓴다.
 * - agy에 대응물이 없는 몫(LSP 서버·출력 스타일·`headersHelper` 서버, 변환기가 경고하는 SSE 서버·훅 이벤트)과 변환에 실패한
 *   플러그인은 건너뛰고 서버 로그에 남긴다. 어떤 실패도 CLI 실행을 막지 않는다.
 *
 * 실을 것이 하나도 없으면 `undefined`. 돌려준 `cleanup`이 임시 폴더를 걷는다.
 */
export async function prepareAntigravityPlugins(options: AntigravityPluginOptions): Promise<AntigravityPluginInjection | undefined> {
  if (options.plugins.length === 0) return undefined;
  let root: string | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (root) await fs.rm(root, { recursive: true, force: true });
  };
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-standalone-antigravity-plugins-"));
    await fs.chmod(root, 0o700);
    // 변환기가 펼쳐 쓰는 경로와 같은 표기로 비교하도록 실제 경로로 시작한다(macOS의 /var → /private/var).
    const base = await fs.realpath(root);
    const home = path.join(base, "home");
    const installed = path.join(home, ".gemini", "config", "plugins");
    const workspace = path.join(base, "workspace");
    const target = path.join(workspace, ".agents", "plugins");
    await fs.mkdir(installed, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    const env = conversionEnv(options.env, home);
    const taken = new Set(options.reservedNames);
    const own = await userPluginNames(options, base);
    let loaded = 0;
    for (const plugin of options.plugins) {
      if (options.signal?.aborted) break;
      if (own.has(plugin.name)) {
        note(plugin, `skipped: Antigravity already has its own "${plugin.name}" plugin installed, which this session uses`);
        continue;
      }
      if (taken.has(plugin.name)) {
        note(plugin, `skipped: another plugin in this session already uses the name "${plugin.name}"`);
        continue;
      }
      for (const line of unsupportedParts(plugin)) note(plugin, line);
      const result = await runAgy(options, [...options.prefixArgs, "plugin", "install", plugin.path], env, home);
      for (const line of converterWarnings(result.output)) note(plugin, line);
      const produced = await fs.readdir(installed);
      if (!result.ok || produced.length !== 1 || taken.has(produced[0]!)) {
        note(plugin, result.ok ? "skipped: the agy converter produced no usable plugin folder" : `skipped: agy plugin conversion failed (${result.reason})`);
        await Promise.all(produced.map((name) => fs.rm(path.join(installed, name), { recursive: true, force: true })));
        continue;
      }
      const folder = produced[0]!;
      const from = path.join(installed, folder);
      const to = path.join(target, folder);
      await fs.rename(from, to);
      await rewriteRootJson(plugin, from, to, options.env);
      taken.add(plugin.name);
      taken.add(folder);
      loaded += 1;
    }
    await fs.rm(home, { recursive: true, force: true });
    if (loaded === 0) {
      await cleanup();
      return undefined;
    }
    return { args: ["--add-dir", workspace], cleanup };
  } catch (error) {
    console.warn(`[standalone-cli] antigravity global plugins skipped: ${messageOf(error)}`);
    await cleanup().catch(() => undefined);
    return undefined;
  }
}

/** 변환 자식의 홈만 임시 폴더로 돌린다(Windows는 USERPROFILE). 설정 폴더를 옮기는 변수는 걷는다. */
function conversionEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: home, USERPROFILE: home };
  delete env.ANTIGRAVITY_CONFIG_REL_DIR;
  return env;
}

/** 사람의 agy에 설치된 플러그인 이름(켜짐 여부와 무관) — 사람의 HOME 그대로 `agy plugin list --json`으로 읽기만 한다. 못 읽으면 빈 목록. */
async function userPluginNames(options: AntigravityPluginOptions, cwd: string): Promise<ReadonlySet<string>> {
  const result = await runAgy(options, [...options.prefixArgs, "plugin", "list", "--json"], options.env, cwd);
  if (!result.ok) return new Set();
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.flatMap((row) => (isRecord(row) && typeof row.name === "string" ? [row.name] : [])));
  } catch {
    return new Set();
  }
}

/**
 * agy 보조 명령 하나. 소유 포트가 있으면 그 그룹으로 띄워 Console이 어떻게 끝나든 함께 끝나게 하고(수명 계약 I2),
 * 시간 초과·Console 종료(`signal`)에는 그룹째 끝낸다. 실패는 던지지 않고 결과로 돌려준다.
 */
function runAgy(options: AntigravityPluginOptions, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ readonly ok: boolean; readonly stdout: string; readonly output: string; readonly reason: string }> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, stdout: "", output: "", reason: "console stopping" });
      return;
    }
    const owned = options.processes?.spawnOwned({ command: options.bin, args, cwd, env, stdin: "ignore" });
    const child: ChildProcess | OwnedChild = owned
      ?? execFile(options.bin, [...args], withHidden({ env, cwd, encoding: "utf-8" as const, maxBuffer: 1 << 20 }));
    let stdout = "";
    let stderr = "";
    let ended: string | null = null;
    const end = (reason: string) => {
      if (ended) return;
      ended = reason;
      if (owned) owned.killGroup("SIGTERM");
      else child.kill("SIGTERM");
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { if (stdout.length < 1 << 20) stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { if (stderr.length < 64_000) stderr += chunk.toString(); });
    const timer = setTimeout(() => end("timed out"), AGY_PLUGIN_CLI_TIMEOUT_MS);
    const onAbort = () => end("console stopping");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const settle = (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ok, stdout, output: `${stdout}\n${stderr}`, reason });
    };
    child.on("error", (error: Error) => settle(false, error.message));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) settle(false, ended);
      else if (code === 0) settle(true, "");
      else settle(false, code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`);
    });
  });
}

/** 변환기가 건너뛴 몫(`⚠` 줄). 경로가 섞이지 않는 문장들이다. */
function converterWarnings(output: string): string[] {
  return output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("⚠"))
    .map((line) => line.replace(/^⚠\s*/, "").slice(0, 300));
}

/** 변환기가 말없이 버리는, agy에 대응물이 없는 구성 요소(agy 1.5.13 실측). */
function unsupportedParts(plugin: StandaloneCliPlugin): string[] {
  const manifest = readManifest(plugin.path);
  const lines: string[] = [];
  if (manifest.lspServers !== undefined || existsSync(path.join(plugin.path, ".lsp.json"))) lines.push("LSP servers skipped: agy has no LSP server component");
  if (manifest.outputStyles !== undefined || existsSync(path.join(plugin.path, "output-styles"))) lines.push("output styles skipped: agy has no output style component");
  return lines;
}

/** 이 플러그인 선언 중 동적 헤더(`headersHelper`)를 쓰는 서버의 선언 키. agy 변환기는 헬퍼를 버리고 서버만 남긴다. */
function headersHelperServers(plugin: StandaloneCliPlugin): Set<string> {
  const prefix = `plugin:${plugin.name}:`;
  const keys = new Set<string>();
  for (const [name, config] of Object.entries(plugin.mcpServers)) {
    if (config.type !== "stdio" && config.headersHelper && name.startsWith(prefix)) keys.add(name.slice(prefix.length));
  }
  return keys;
}

async function rewriteRootJson(plugin: StandaloneCliPlugin, from: string, to: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const file of ROOT_JSON_FILES) {
    const full = path.join(to, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf8"));
    } catch {
      continue;
    }
    const isMcp = file === "mcp_config.json";
    const unresolved = new Set<string>();
    const fill = (text: string): string => text.replace(PLACEHOLDER, (match, name: string, fallback: string | undefined) => {
      const value = plugin.env[name] ?? env[name] ?? fallback;
      if (value === undefined) {
        unresolved.add(name);
        return match;
      }
      return value;
    });
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string") {
        const moved = value.split(from).join(to);
        return isMcp ? fill(moved) : moved;
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      return value;
    };
    if (isMcp && isRecord(parsed) && isRecord(parsed.mcpServers)) {
      const servers = { ...parsed.mcpServers };
      for (const key of headersHelperServers(plugin)) {
        if (!(key in servers)) continue;
        delete servers[key];
        note(plugin, `MCP server "${key}" skipped: its headersHelper can't be carried to agy`);
      }
      parsed = { ...parsed, mcpServers: servers };
    }
    await fs.writeFile(full, `${JSON.stringify(rewrite(parsed), null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(full, 0o600);
    if (unresolved.size > 0) note(plugin, `MCP values left unfilled (no key set): ${[...unresolved].join(", ")}`);
  }
}

function readManifest(dir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

function note(plugin: StandaloneCliPlugin, line: string): void {
  console.warn(`[standalone-cli] antigravity plugin ${plugin.id}: ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
