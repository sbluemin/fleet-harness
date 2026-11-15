import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AcpPluginSource } from "./contract.js";

/**
 * Fleet 플러그인(Claude Code 형식)을 agy가 읽을 수 있게 하는 파생 캐시.
 *
 * 상태를 관리하지 않는다. 설치·활성 목록도, 동기화도 없다. `pluginCacheDir`(`…/commodore-plugins/agy`)는
 * 지워도 되는 파생 사본이고, 세션을 시작할 때마다 그 세션이 고른 플러그인을 Claude 쪽 설치본에서 다시 변환해 덮어쓴다.
 *
 * 변환은 `HOME=<임시 HOME> agy plugin install <dir>` — `agy plugin install`에는 위치 플래그가 없고
 * `$HOME/.gemini/config/plugins/<name>`에 쓴다(agy 1.5.9 실측). 결과 디렉터리를 캐시의 `<name>`으로 교체한다.
 * 교체는 rename이라, 동시에 뜨는 다른 세션이 반쯤 지어진 디렉터리를 읽지 않는다. 같은 프로세스의 변환은 직렬화한다.
 */
export interface AgyPluginConversionOptions {
  readonly pluginCacheDir: string;
  readonly plugins: readonly AcpPluginSource[];
  readonly command: string;
  readonly commandArgs?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

const SWAP_ATTEMPTS = 3;

let conversionTail: Promise<unknown> = Promise.resolve();

/** 캐시를 갱신하고 세션이 읽을 플러그인 이름(`include_only`)을 돌려준다. */
export function refreshAgyPluginCache(options: AgyPluginConversionOptions): Promise<readonly string[]> {
  const run = conversionTail.then(() => convertPlugins(options));
  conversionTail = run.catch(() => undefined);
  return run;
}

async function convertPlugins(options: AgyPluginConversionOptions): Promise<readonly string[]> {
  if (options.plugins.length === 0) return [];
  await mkdir(options.pluginCacheDir, { recursive: true });
  // 캐시와 같은 파일시스템에 둬야 rename이 원자적이다.
  const scratch = await mkdtemp(path.join(path.dirname(options.pluginCacheDir), ".agy-convert-"));
  try {
    const convertedRoot = path.join(scratch, ".gemini", "config", "plugins");
    const installed = new Set<string>();
    for (const plugin of options.plugins) {
      const before = await listNames(convertedRoot);
      await runAgy(options, ["plugin", "install", plugin.dir], scratch, plugin.name);
      const added = (await listNames(convertedRoot)).filter((name) => !before.includes(name));
      if (added.length === 0) throw new Error(`agy plugin install produced no plugin for ${plugin.name}.`);
      for (const name of added) installed.add(name);
    }
    const names = [...installed];
    for (const name of names) await swapIntoCache(options.pluginCacheDir, convertedRoot, scratch, name);
    return names;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * 변환본을 캐시의 `<name>`으로 rename 교체한다. 다른 프로세스(같은 데이터 루트를 쓰는 두 번째 Console)가
 * 같은 이름을 동시에 교체하면 rename이 ENOTEMPTY·ENOENT로 질 수 있다 — 몇 번 다시 시도하고, 그래도 지면
 * 그쪽이 놓은 완성본이 이미 있으므로 그것을 쓴다(그것도 없을 때만 실패).
 */
async function swapIntoCache(cacheDir: string, convertedRoot: string, scratch: string, name: string): Promise<void> {
  const target = path.join(cacheDir, name);
  let lastError: unknown;
  for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
    const retired = path.join(scratch, `retired-${name}-${attempt}`);
    try {
      const existing = await rename(target, retired).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      await rename(path.join(convertedRoot, name), target);
      if (existing) await rm(retired, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (await stat(path.join(target, "plugin.json")).then(() => true, () => false)) return;
  throw lastError;
}

async function listNames(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function runAgy(options: AgyPluginConversionOptions, args: readonly string[], home: string, pluginName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, [...(options.commandArgs ?? []), ...args], {
      env: { ...options.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_096); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agy plugin install failed for ${pluginName} (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * 세션 gemini-dir의 `config/plugins.json`. 형식은 객체다 — 배열은 agy가 무시한다. `include_only`가 이 세션이 고른
 * 이름만 보이게 하고, 같은 캐시 안의 다른 플러그인은 가린다.
 */
export async function writeAgySessionPlugins(geminiDir: string, pluginCacheDir: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const configDir = path.join(geminiDir, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "plugins.json"),
    `${JSON.stringify({ entries: [{ path: pluginCacheDir, include_only: names }] }, null, 2)}\n`,
  );
}
