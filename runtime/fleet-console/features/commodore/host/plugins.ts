import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { OwnedProcessPort } from "@fleet-console/process";
import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";

import { CommodoreStoreError } from "./errors.js";
import {
  MAX_CUSTOM_MARKETPLACES,
  PRESET_MARKETPLACES,
  splitPluginId,
  type MarketplaceErrorCode,
  type MarketplaceSourceKind,
  type MarketplaceView,
  type PluginCatalogEntry,
  type PluginCatalogView,
  type PluginComponents,
} from "../shared/contracts/plugins.js";

/**
 * 사령관 플러그인 등록부 — Console 데이터의 Fleet 전용 Claude 홈 하나를 소유한다.
 *
 * ```
 * <root>/registry.json   마켓플레이스 목록(기본 제공·커스텀, 켜짐·상태)과 신뢰한 플러그인 버전 — Fleet 의 진실
 * <root>/claude/          `claude plugin …` 이 쓰는 CLAUDE_CONFIG_DIR(known_marketplaces·installed_plugins·cache)
 * <root>/loaded/          marketplace.json 이 구성 요소를 선언하는(strict:false) 플러그인의 자립 사본
 * ```
 *
 * 받기·설치는 Claude Code CLI 에 맡긴다(github·git·URL 출처, 인증, 캐시). 사용자 `~/.claude` 는 읽지도 쓰지도 않는다.
 * 세션은 설치본 경로를 로컬 플러그인으로 싣는다. strict:false 플러그인은 설치본에 plugin.json 이 없어 로컬로 실으면
 * 구성 요소가 비므로(CLI 2.1.310 실측) 사본을 만들고 marketplace 항목의 구성 요소 선언을 plugin.json 으로 옮긴다.
 * Console 프로세스는 플러그인 코드를 실행하지 않는다 — 싣는 쪽은 언제나 세션의 Claude 자식이다.
 */

export interface CommodorePluginsOptions {
  /** `<consoleDataDir>/commodore-plugins`. */
  readonly root: string;
  readonly executable: () => Promise<string>;
  readonly processes?: OwnedProcessPort;
  readonly now?: () => number;
  /** 자식에게 줄 기반 환경. 생략하면 Console 프로세스 환경이다. */
  readonly env?: () => NodeJS.ProcessEnv;
}

/** 세션이 싣는 플러그인 하나 — 로컬 경로와, 호스트가 대신 소유할 MCP 선언. */
export interface ResolvedPlugin {
  readonly id: string;
  readonly path: string;
  readonly mcpServers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
}

interface RegistryMarketplace {
  readonly name: string;
  readonly kind: MarketplaceSourceKind;
  readonly locator: string;
  readonly ref?: string;
  readonly preset: boolean;
  readonly enabled: boolean;
  readonly status: "ready" | "syncing" | "failed";
  readonly error?: MarketplaceErrorCode;
  readonly updatedAt?: number;
}

interface Registry {
  readonly version: 1;
  readonly marketplaces: readonly RegistryMarketplace[];
  /** 실행 명령이 있는 플러그인을 사람이 신뢰한 버전. 버전이 바뀌면 다시 묻는다. */
  readonly trusted: Readonly<Record<string, string>>;
}

interface CliResult {
  readonly outcome?: string;
  readonly failureCode?: string;
  readonly message?: string;
  readonly marketplace?: string;
}

interface MarketplaceEntry {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly strict?: boolean;
  readonly [key: string]: unknown;
}

const PRESET_REFRESH_MS = 24 * 60 * 60_000;
const CLI_TIMEOUT_MS = 180_000;
const COMPONENT_KEYS = ["commands", "agents", "skills", "hooks", "mcpServers", "lspServers", "outputStyles"] as const;
const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;

/** 사람이 넣은 출처를 알아본다. 파일 경로는 받지 않는다 — 원격 Console 에서 서버 디스크를 가리키는 통로가 되지 않게. */
export function detectMarketplaceSource(raw: string, rawRef?: string): { readonly kind: MarketplaceSourceKind; readonly locator: string; readonly ref?: string; readonly cliSource: string } | null {
  const value = raw.trim();
  const refPattern = /^[A-Za-z0-9._/-]{1,128}$/;
  const split = (input: string, separator: "@" | "#"): [string, string | undefined] => {
    const at = input.lastIndexOf(separator);
    return at > 0 && refPattern.test(input.slice(at + 1)) ? [input.slice(0, at), input.slice(at + 1)] : [input, undefined];
  };
  const pick = (inline: string | undefined) => {
    const ref = rawRef?.trim() || inline;
    if (ref !== undefined && (!refPattern.test(ref) || ref.startsWith("-"))) return null;
    return ref;
  };
  if (/\s/.test(value) || value.startsWith("-")) return null;
  const ssh = /^(?:git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+?(?:\.git)?|ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+?(?:\.git)?)$/;
  {
    const [base, inline] = value.startsWith("git@") ? split(value, "#") : split(value, "#");
    if (ssh.test(base)) { const ref = pick(inline); if (ref === null) return null; return { kind: "git", locator: base, ...(ref ? { ref } : {}), cliSource: ref ? `${base}#${ref}` : base }; }
  }
  if (/^https:\/\/\S+$/i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.username || url.password) return null;
    if (/\.json$/i.test(url.pathname)) return rawRef?.trim() ? null : { kind: "url", locator: url.href, cliSource: url.href };
    const [base, inline] = split(`${url.origin}${url.pathname}`, "#");
    const ref = pick(url.hash ? url.hash.slice(1) : inline);
    if (ref === null) return null;
    return { kind: "git", locator: base, ...(ref ? { ref } : {}), cliSource: ref ? `${base}#${ref}` : base };
  }
  const [base, inline] = split(value, "@");
  if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(base) && !base.endsWith(".git")) {
    const ref = pick(inline);
    if (ref === null) return null;
    return { kind: "github", locator: base, ...(ref ? { ref } : {}), cliSource: ref ? `${base}@${ref}` : base };
  }
  return null;
}

const readJson = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 그 디렉터리 안에 머무는 상대 경로만 푼다. */
function inside(root: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative.trim()) return null;
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

export function createCommodorePlugins(options: CommodorePluginsOptions) {
  const now = options.now ?? Date.now;
  const home = path.join(options.root, "claude");
  const loadedRoot = path.join(options.root, "loaded");
  const registryFile = path.join(options.root, "registry.json");
  let queue: Promise<unknown> = Promise.resolve();
  let ensuring: Promise<void> | null = null;

  /** CLI 는 같은 홈의 파일을 고쳐 쓰므로 한 번에 하나씩만 돈다. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const readRegistry = (): Registry => {
    const raw = readJson(registryFile);
    if (isRecord(raw) && raw.version === 1 && Array.isArray(raw.marketplaces)) {
      return { version: 1, marketplaces: raw.marketplaces.filter((row): row is RegistryMarketplace => isRecord(row) && typeof row.name === "string" && segment.test(row.name)), trusted: isRecord(raw.trusted) ? raw.trusted as Record<string, string> : {} };
    }
    return { version: 1, marketplaces: [], trusted: {} };
  };
  const writeRegistry = (registry: Registry): void => {
    fs.mkdirSync(options.root, { recursive: true });
    const tmp = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, registryFile);
  };
  const update = (change: (registry: Registry) => Registry): Registry => { const next = change(readRegistry()); writeRegistry(next); return next; };
  const patchMarketplace = (name: string, patch: Partial<RegistryMarketplace>, clearError = false) => update((registry) => ({
    ...registry,
    marketplaces: registry.marketplaces.map((row) => {
      if (row.name !== name) return row;
      const { error: _error, ...rest } = row;
      return { ...(clearError ? rest : row), ...patch };
    }),
  }));

  const runCli = async (args: readonly string[]): Promise<CliResult> => {
    const command = await options.executable();
    fs.mkdirSync(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...(options.env?.() ?? process.env), CLAUDE_CONFIG_DIR: home, GIT_TERMINAL_PROMPT: "0" };
    for (const key of Object.keys(env)) if (key.startsWith("FLEET_CONSOLE_")) delete env[key];
    return await new Promise<CliResult>((resolve) => {
      const fullArgs = ["plugin", ...args, "--json"];
      const owned = options.processes?.spawnOwned({ command, args: fullArgs, cwd: options.root, env, stdin: "ignore" });
      const child = owned ?? spawn(command, fullArgs, { cwd: options.root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 64_000) stderr += chunk.toString("utf8"); });
      const timer = setTimeout(() => { if (owned) owned.killGroup("SIGTERM"); else child.kill("SIGTERM"); }, CLI_TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); resolve({ outcome: "failed", failureCode: "spawn_failed" }); });
      child.on("close", () => {
        clearTimeout(timer);
        const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
        let parsed: unknown;
        try { parsed = line ? JSON.parse(line) : undefined; } catch { parsed = undefined; }
        resolve(isRecord(parsed) ? parsed as CliResult : { outcome: "failed", failureCode: "unparsed", message: stderr.slice(-400) });
      });
    });
  };

  const errorCode = (result: CliResult): MarketplaceErrorCode => {
    const text = `${result.failureCode ?? ""} ${result.message ?? ""}`.toLowerCase();
    if (result.failureCode === "invalid_source") return "invalid_source";
    if (/auth|permission denied|could not read username|publickey|403|401/.test(text)) return "auth_failed";
    if (/marketplace\.json|manifest/.test(text)) return "no_manifest";
    if (result.failureCode === "not_found" || /not found|404|does not exist/.test(text)) return "not_found";
    return "fetch_failed";
  };

  const known = (): Record<string, { readonly installLocation?: string }> => {
    const raw = readJson(path.join(home, "plugins", "known_marketplaces.json"));
    return isRecord(raw) ? raw as Record<string, { readonly installLocation?: string }> : {};
  };
  const installed = (): Record<string, readonly { readonly installPath?: string; readonly version?: string }[]> => {
    const raw = readJson(path.join(home, "plugins", "installed_plugins.json"));
    return isRecord(raw) && isRecord(raw.plugins) ? raw.plugins as Record<string, readonly { readonly installPath?: string; readonly version?: string }[]> : {};
  };

  /** marketplace.json 의 플러그인 항목. 위치가 파일(url 출처)이든 디렉터리든 읽는다. */
  const entriesOf = (name: string): readonly MarketplaceEntry[] => {
    const location = known()[name]?.installLocation;
    if (!location) return [];
    let file = location;
    try { if (fs.statSync(location).isDirectory()) file = path.join(location, ".claude-plugin", "marketplace.json"); } catch { return []; }
    const raw = readJson(file);
    if (!isRecord(raw) || !Array.isArray(raw.plugins)) return [];
    return raw.plugins.filter((entry): entry is MarketplaceEntry => isRecord(entry) && typeof entry.name === "string" && segment.test(entry.name));
  };
  const entryOf = (id: string): MarketplaceEntry | undefined => {
    const { plugin, marketplace } = splitPluginId(id);
    return entriesOf(marketplace).find((entry) => entry.name === plugin);
  };

  /**
   * 세션이 실을 디렉터리. 설치본에 plugin.json 이 있거나 marketplace 항목이 strict 이면 설치본 그대로다.
   * strict:false 이면 설치본을 `loaded/` 로 복사하고 항목의 구성 요소 선언을 plugin.json 으로 쓴다.
   */
  const loadDirOf = (id: string): string | null => {
    const install = installed()[id]?.[0];
    if (!install?.installPath || !fs.existsSync(install.installPath)) return null;
    const entry = entryOf(id);
    const ownManifest = fs.existsSync(path.join(install.installPath, ".claude-plugin", "plugin.json"));
    if (ownManifest || entry?.strict !== false) return install.installPath;
    const { plugin, marketplace } = splitPluginId(id);
    const target = path.join(loadedRoot, marketplace, plugin, path.basename(install.installPath));
    if (fs.existsSync(path.join(target, ".claude-plugin", "plugin.json"))) return target;
    fs.rmSync(path.join(loadedRoot, marketplace, plugin), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(install.installPath, target, { recursive: true, dereference: false, filter: (source) => path.basename(source) !== ".in_use" });
    const manifest: Record<string, unknown> = { name: plugin };
    if (typeof entry.version === "string") manifest.version = entry.version;
    if (typeof entry.description === "string") manifest.description = entry.description;
    for (const key of COMPONENT_KEYS) if (entry[key] !== undefined) manifest[key] = entry[key];
    fs.mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    fs.rmSync(path.join(target, ".claude-plugin", "marketplace.json"), { force: true });
    fs.writeFileSync(path.join(target, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return target;
  };

  const manifestOf = (dir: string): Record<string, unknown> => {
    const raw = readJson(path.join(dir, ".claude-plugin", "plugin.json"));
    return isRecord(raw) ? raw : {};
  };
  /** 선언된 경로 목록(문자열·배열)을 기본 디렉터리와 함께 푼다. */
  const declaredDirs = (dir: string, declared: unknown, fallback: string): string[] => {
    const list = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
    return [...new Set([path.join(dir, fallback), ...list.map((item) => inside(dir, item)).filter((item): item is string => item !== null)])];
  };
  const countEntries = (dirs: readonly string[], match: (name: string, full: string) => boolean): number => {
    let count = 0;
    for (const dir of dirs) {
      let stat: fs.Stats;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (stat.isFile()) { if (match(path.basename(dir), dir)) count += 1; continue; }
      if (match(path.basename(dir), dir) && fs.existsSync(path.join(dir, "SKILL.md"))) { count += 1; continue; }
      for (const name of fs.readdirSync(dir)) if (match(name, path.join(dir, name))) count += 1;
    }
    return count;
  };

  /** 플러그인의 MCP 선언 — manifest `mcpServers`(객체 또는 json 경로)와 루트 `.mcp.json`. `${CLAUDE_PLUGIN_ROOT}` 를 펼친다. */
  const mcpDeclarations = (dir: string): Record<string, Record<string, unknown>> => {
    const servers: Record<string, Record<string, unknown>> = {};
    const absorb = (value: unknown) => {
      const table = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : value;
      if (!isRecord(table)) return;
      for (const [name, config] of Object.entries(table)) if (isRecord(config) && segment.test(name)) servers[name] = config;
    };
    const declared = manifestOf(dir).mcpServers;
    for (const item of Array.isArray(declared) ? declared : [declared]) {
      if (typeof item === "string") { const file = inside(dir, item); if (file) absorb(readJson(file)); }
      else absorb(item);
    }
    absorb(readJson(path.join(dir, ".mcp.json")));
    const expand = (text: string) => text.replaceAll("${CLAUDE_PLUGIN_ROOT}", dir);
    const deep = (value: unknown): unknown => typeof value === "string" ? expand(value) : Array.isArray(value) ? value.map(deep) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value;
    return Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, deep(config) as Record<string, unknown>]));
  };
  const hookCommands = (dir: string): string[][] => {
    const commands: string[][] = [];
    const absorb = (value: unknown) => {
      const table = isRecord(value) && isRecord(value.hooks) ? value.hooks : value;
      if (!isRecord(table)) return;
      for (const [event, groups] of Object.entries(table)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) for (const hook of isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []) {
          if (isRecord(hook) && typeof hook.command === "string") commands.push([event, hook.command]);
        }
      }
    };
    const declared = manifestOf(dir).hooks;
    for (const item of Array.isArray(declared) ? declared : [declared]) {
      if (typeof item === "string") { const file = inside(dir, item); if (file) absorb(readJson(file)); }
      else absorb(item);
    }
    absorb(readJson(path.join(dir, "hooks", "hooks.json")));
    return commands;
  };

  const describe = (id: string, dir: string): Pick<PluginCatalogEntry, "components" | "runs" | "version"> => {
    const manifest = manifestOf(dir);
    const hooks = hookCommands(dir);
    const mcp = mcpDeclarations(dir);
    const components: PluginComponents = {
      skills: countEntries(declaredDirs(dir, manifest.skills, "skills"), (name, full) => fs.existsSync(path.join(full, "SKILL.md"))),
      agents: countEntries(declaredDirs(dir, manifest.agents, "agents"), (name) => name.endsWith(".md")),
      commands: countEntries(declaredDirs(dir, manifest.commands, "commands"), (name) => name.endsWith(".md")),
      hooks: hooks.length,
      mcp: Object.keys(mcp).length,
    };
    const runs = [
      ...hooks.map(([event, command]) => ({ kind: "hook" as const, label: event!, command: command! })),
      ...Object.entries(mcp).map(([name, config]) => ({ kind: "mcp" as const, label: name, command: typeof config.command === "string" ? [config.command, ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(" ") : typeof config.url === "string" ? config.url : name })),
    ].filter((run) => run.kind === "hook" || !/^https?:/.test(run.command));
    const version = typeof manifest.version === "string" ? manifest.version : installed()[id]?.[0]?.version;
    return { components, ...(runs.length ? { runs } : {}), ...(version ? { version } : {}) };
  };

  const view = (row: RegistryMarketplace): MarketplaceView => ({
    name: row.name, kind: row.kind, locator: row.locator, ...(row.ref ? { ref: row.ref } : {}),
    preset: row.preset, enabled: row.enabled, status: row.status, ...(row.error ? { error: row.error } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}), pluginCount: entriesOf(row.name).length,
  });
  const catalog = (): PluginCatalogView => {
    const registry = readRegistry();
    const installs = installed();
    const plugins: PluginCatalogEntry[] = [];
    for (const row of registry.marketplaces) {
      if (!row.enabled) continue;
      for (const entry of entriesOf(row.name)) {
        const id = `${entry.name}@${row.name}`;
        const dir = installs[id] ? loadDirOf(id) : null;
        plugins.push({ id, name: entry.name, marketplace: row.name, ...(typeof entry.description === "string" ? { description: entry.description.slice(0, 600) } : {}),
          ...(typeof entry.version === "string" ? { version: entry.version } : {}), ...(dir ? describe(id, dir) : {}) });
      }
    }
    const order = new Map<string, number>(PRESET_MARKETPLACES.map((preset, index) => [preset.name, index]));
    const marketplaces = [...registry.marketplaces].sort((a, b) => (a.preset === b.preset ? (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0) : a.preset ? -1 : 1)).map(view);
    return { marketplaces, plugins };
  };

  /** 출처를 받아 등록한다. 성공하면 CLI 가 알려 준 marketplace.json name 으로 남긴다. */
  const fetchMarketplace = async (source: { readonly kind: MarketplaceSourceKind; readonly locator: string; readonly ref?: string; readonly cliSource: string }, preset: boolean, expected?: string): Promise<MarketplaceView> => {
    const result = await runCli(["marketplace", "add", source.cliSource]);
    if (result.outcome !== "ok" || !result.marketplace || !segment.test(result.marketplace)) {
      if (expected) patchMarketplace(expected, { status: "failed", error: errorCode(result) });
      throw new CommodoreStoreError(errorCode(result));
    }
    const name = result.marketplace;
    const isPresetName = PRESET_MARKETPLACES.some((item) => item.name === name);
    if (!preset && isPresetName) { await runCli(["marketplace", "remove", name]).catch(() => undefined); throw new CommodoreStoreError("preset_name"); }
    if (expected && expected !== name) { patchMarketplace(expected, { status: "failed", error: "no_manifest" }); throw new CommodoreStoreError("no_manifest"); }
    const row: RegistryMarketplace = { name, kind: source.kind, locator: source.locator, ...(source.ref ? { ref: source.ref } : {}), preset, enabled: true, status: "ready", updatedAt: now() };
    const registry = update((current) => {
      const existing = current.marketplaces.find((item) => item.name === name);
      const merged = existing ? { ...row, enabled: existing.enabled } : row;
      return { ...current, marketplaces: existing ? current.marketplaces.map((item) => item.name === name ? merged : item) : [...current.marketplaces, merged] };
    });
    return view(registry.marketplaces.find((item) => item.name === name)!);
  };

  /** 기본 제공 다섯 곳을 등록하고, 하루 지난 것은 새로 받는다. 배경에서 돈다 — 실패는 그 행의 상태로 남는다. */
  const ensurePresets = (): Promise<void> => ensuring ??= serial(async () => {
    try {
      for (const preset of PRESET_MARKETPLACES) {
        const row = readRegistry().marketplaces.find((item) => item.name === preset.name);
        if (row && row.status === "ready" && row.updatedAt && now() - row.updatedAt < PRESET_REFRESH_MS && known()[preset.name]) continue;
        if (!row) update((registry) => ({ ...registry, marketplaces: [...registry.marketplaces, { name: preset.name, kind: "github", locator: preset.repo, preset: true, enabled: true, status: "syncing" }] }));
        else patchMarketplace(preset.name, { status: "syncing" });
        if (known()[preset.name]) {
          const result = await runCli(["marketplace", "update", preset.name]);
          patchMarketplace(preset.name, result.outcome === "ok" ? { status: "ready", updatedAt: now() } : { status: known()[preset.name] ? "ready" : "failed", ...(result.outcome === "ok" ? {} : { error: errorCode(result) }) }, result.outcome === "ok");
        } else {
          await fetchMarketplace({ kind: "github", locator: preset.repo, cliSource: preset.repo }, true, preset.name).catch(() => undefined);
        }
      }
    } finally { ensuring = null; }
  });

  const requireRow = (name: string): RegistryMarketplace => {
    const row = readRegistry().marketplaces.find((item) => item.name === name);
    if (!row) throw new CommodoreStoreError("not_found");
    return row;
  };

  /** 받아 두고(Fleet 홈에 설치) 구성 요소와 실행 명령을 채운 항목. 꺼진 마켓플레이스는 거절한다. */
  const inspect = (id: string): Promise<PluginCatalogEntry> => serial(async () => {
    const { plugin, marketplace } = splitPluginId(id);
    const row = requireRow(marketplace);
    if (!row.enabled) throw new CommodoreStoreError("disabled");
    const entry = entryOf(id);
    if (!entry) throw new CommodoreStoreError("plugin_not_found");
    if (!installed()[id] || !loadDirOf(id)) {
      const result = await runCli(["install", id]);
      if (result.outcome !== "ok") throw new CommodoreStoreError("install_failed");
    }
    const dir = loadDirOf(id);
    if (!dir) throw new CommodoreStoreError("install_failed");
    return { id, name: plugin, marketplace, ...(typeof entry.description === "string" ? { description: entry.description.slice(0, 600) } : {}), ...describe(id, dir) };
  });

  return {
    /** Console 이 뜰 때 한 번 — 기본 제공 등록·갱신을 배경에서 시작한다. */
    start(): void { void ensurePresets(); },
    catalog(): PluginCatalogView { void ensurePresets(); return catalog(); },
    async add(rawSource: string, ref?: string): Promise<MarketplaceView> {
      const source = detectMarketplaceSource(rawSource, ref);
      if (!source) throw new CommodoreStoreError("invalid_source");
      const registry = readRegistry();
      if (registry.marketplaces.some((row) => row.locator === source.locator && (row.ref ?? "") === (source.ref ?? ""))) throw new CommodoreStoreError("duplicate");
      if (registry.marketplaces.filter((row) => !row.preset).length >= MAX_CUSTOM_MARKETPLACES) throw new CommodoreStoreError("limit");
      return await serial(async () => {
        try { return await fetchMarketplace(source, false); }
        catch (error) { throw error instanceof CommodoreStoreError ? error : new CommodoreStoreError("fetch_failed"); }
      });
    },
    async refresh(name?: string): Promise<PluginCatalogView> {
      const names = name ? [requireRow(name).name] : readRegistry().marketplaces.map((row) => row.name);
      await serial(async () => {
        for (const target of names) {
          patchMarketplace(target, { status: "syncing" });
          const result = await runCli(["marketplace", "update", target]);
          patchMarketplace(target, result.outcome === "ok" ? { status: "ready", updatedAt: now() } : { status: "failed", error: errorCode(result) }, result.outcome === "ok");
        }
      });
      return catalog();
    },
    enable(name: string, enabled: boolean): PluginCatalogView {
      requireRow(name);
      patchMarketplace(name, { enabled });
      return catalog();
    },
    async remove(name: string): Promise<PluginCatalogView> {
      const row = requireRow(name);
      if (row.preset) throw new CommodoreStoreError("preset_locked");
      await serial(async () => {
        await runCli(["marketplace", "remove", name]);
        update((registry) => ({ ...registry, marketplaces: registry.marketplaces.filter((item) => item.name !== name) }));
      });
      return catalog();
    },
    inspect,
    /** 설치 전 확인 — 실행 명령이 있고 이 버전을 신뢰한 적이 없으면 trust_required. trusted 면 기록한다. */
    async prepareInstall(id: string, trusted: boolean): Promise<void> {
      const entry = await inspect(id);
      if (!entry.runs?.length) return;
      const version = entry.version ?? "unversioned";
      if (readRegistry().trusted[id] === version) return;
      if (!trusted) throw new CommodoreStoreError("trust_required");
      update((registry) => ({ ...registry, trusted: { ...registry.trusted, [id]: version } }));
    },
    /**
     * 세션을 여는 순간 고른 플러그인을 경로와 MCP 선언으로 푼다. 받지 않았거나 사라진 것은 건너뛴다 — 세션을 막지 않는다.
     * 마켓플레이스를 꺼도 이미 설치한 것은 실린다(끄기는 새 설치만 막는다).
     */
    resolve(ids: readonly string[]): readonly ResolvedPlugin[] {
      const resolved: ResolvedPlugin[] = [];
      for (const id of ids) {
        let dir: string | null = null;
        try { dir = loadDirOf(id); } catch (error) { console.warn(`[commodore] plugin ${id} unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        if (!dir) continue;
        const { plugin } = splitPluginId(id);
        const mcpServers: Record<string, ClaudeGatewayExternalMcpServer> = {};
        for (const [server, config] of Object.entries(mcpDeclarations(dir))) {
          const name = `plugin_${plugin}_${server}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
          const type = config.type === "http" || config.type === "sse" ? config.type : typeof config.url === "string" && config.command === undefined ? "http" : "stdio";
          if (type === "stdio" && typeof config.command === "string") {
            mcpServers[name] = { type: "stdio", command: config.command, ...(Array.isArray(config.args) ? { args: config.args.map(String) } : {}), ...(isRecord(config.env) ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, String(value)])) } : {}) };
          } else if (type !== "stdio" && typeof config.url === "string") {
            mcpServers[name] = { type, url: config.url, ...(isRecord(config.headers) ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value)])) } : {}) };
          }
        }
        resolved.push({ id, path: dir, mcpServers });
      }
      return resolved;
    },
  };
}
export type CommodorePlugins = ReturnType<typeof createCommodorePlugins>;
