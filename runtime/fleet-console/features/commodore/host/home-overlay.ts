import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClaudeGatewayExternalMcpServer, ClaudeGatewayLocalPlugin } from "@fleet-console/agent-runtime/claude";

import { externalMcpServerOf, manifestOf, pluginMcpServers, pluginNameOf, type ResolvedPlugin } from "./plugins.js";

/**
 * 사령관 세션에 사람의 실제 Claude 홈에서 MCP 서버·스킬·켜 둔 플러그인만 더한다(+@). 자식의 `CLAUDE_CONFIG_DIR`는
 * 그대로 세션의 임시 홈이고 `settingSources: []`·`strictMcpConfig`도 그대로다 — 홈은 여기서 읽기만 한다.
 *
 * 홈의 CLAUDE.md·훅·권한·env·모델·auto-memory는 싣지 않는다. settings.json 에서는 `enabledPlugins`만,
 * `.claude.json` 에서는 최상위 `mcpServers`(사용자 범위)만 읽는다. 플러그인 설치 폴더는 그대로 싣지 않는다 — 그러면
 * 훅·LSP·`.mcp.json`·bin 이 함께 실린다. 세션 전용 임시 폴더에 플러그인을 새로 세우고 스킬·커맨드 항목과, 그 본문이
 * `${CLAUDE_PLUGIN_ROOT}/…`로 가리키는 실행 요소 아닌 루트 항목만 링크한다. 플러그인 MCP 는 선언을 옮겨 호스트가 연다.
 *
 * 이름이 겹치면 Fleet 이 우선한다 — 플러그인 이름, 스킬·커맨드 이름, 정규화한 MCP 서버 이름, 호스트 예약 도구 묶음.
 * 읽을 수 없거나 형식을 모르는 홈 데이터는 그 항목만 빼고 이유 코드를 남긴다. 어떤 경우에도 사령관 기동을 막지 않는다.
 * Console 은 여기서 아무것도 실행하지 않는다 — 싣는 쪽은 세션의 Claude 자식이다.
 */

/** 사람의 실제 Claude 홈 — 설정 폴더와 전역 설정 파일(`.claude.json`). */
export interface ClaudeHomeLocation {
  readonly configDir: string;
  readonly configFile: string;
}

/** 터미널의 Claude Code 가 쓰는 그 홈. 규칙은 자격증명 해석·Theater 신뢰 쓰기와 같다. */
export function userClaudeHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): ClaudeHomeLocation {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configured || path.join(homedir, ".claude");
  const legacy = path.join(configDir, ".config.json");
  return { configDir, configFile: fs.existsSync(legacy) ? legacy : path.join(configured || homedir, ".claude.json") };
}

/** 뺀 홈 항목 — 이름과 이유 코드만. 경로·값은 싣지 않는다. */
export interface HomeOverlaySkip {
  readonly kind: "home" | "plugin" | "skill" | "command" | "mcp";
  readonly name: string;
  readonly reason: "fleet_precedence" | "duplicate" | "unreadable" | "unsupported" | "not_installed" | "missing" | "hooks" | "name_invalid" | "reserved_placeholder" | "limit";
}

export interface ClaudeHomeOverlay {
  readonly plugins: readonly ClaudeGatewayLocalPlugin[];
  readonly mcpServers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
  /** 홈 MCP 선언에서 옮긴 글자 그대로의 헤더·환경 값 — 선언은 `${이름}`만 들고 자식 환경에 얹는다(argv 에 싣지 않는다). */
  readonly env: Readonly<Record<string, string>>;
  readonly skipped: readonly HomeOverlaySkip[];
  /** 세운 임시 플러그인 폴더를 지운다. 세션 폐기가 부른다. */
  release(): Promise<void>;
}

export interface HomeOverlayFleet {
  /** 이 세션이 싣는 Fleet 사령관 플러그인. */
  readonly plugins: readonly Pick<ResolvedPlugin, "name" | "path" | "mcpServers">[];
  /** 호스트가 싣는 도구 묶음 이름 — 홈 MCP 서버가 쓸 수 없다. */
  readonly reservedGroups: readonly string[];
}

const SKILLS_PLUGIN = "home-skills";
const INSTALL_SCHEMA_VERSION = 2;
const MAX_SKILLS = 200;
const MAX_PLUGINS = 50;
const MAX_MCP_SERVERS = 50;
const MAX_MARKDOWN_BYTES = 256 * 1024;
const LIFTED_ENV_PREFIX = "FLEET_HOME_MCP_";
const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const MCP_NAME = /^[a-zA-Z0-9_.:-]+$/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
/** 실행 환경·Console·게이트웨이 내부 이름 — 홈 선언이 이 값을 외부 서버로 끌어가지 못하게 그런 선언은 뺀다. */
const RESERVED_PLACEHOLDER = /^(?:FLEET|CLAUDE|ANTHROPIC)_/;
/** 플러그인 루트에서 Claude Code 가 스스로 찾아 싣거나 실행하는 자리 — 본문이 가리켜도 링크하지 않는다. */
const BEHAVIOR_ENTRIES = new Set(["hooks", "agents", "monitors", "bin", "output-styles", "settings.json", "skills", "commands"]);
const ROOT_REFERENCE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^/\s`'"()<>\]]+)/g;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fold = (name: string) => name.toLowerCase();

/** 없는 파일은 `undefined`, 읽었지만 JSON 이 아니면 `null`. */
function readJson(file: string): unknown {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function isDirectory(file: string): boolean {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** 어휘로 그 폴더 안에 머무는 상대 경로만. */
function inside(root: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative.trim()) return null;
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/** 링크를 푼 실제 경로도 그 폴더 안인가. */
function staysInside(root: string, candidate: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch { return false; }
}

function readMarkdown(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_MARKDOWN_BYTES));
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8").replace(/^﻿/, "");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

/** 머리말(frontmatter)에 `hooks`를 선언한 스킬·커맨드 — 쓰는 동안 명령을 실행하므로 싣지 않는다. */
function declaresHooks(markdown: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return !!match && /^hooks\s*:/m.test(match[1]!);
}

/** 선언된 경로 목록(문자열·배열)과 기본 폴더 — 플러그인 안에 머무는 것만. */
function declaredPaths(dir: string, declared: unknown, fallback: string): string[] {
  const list = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
  return [...new Set([path.join(dir, fallback), ...list.map((item) => inside(dir, item)).filter((item): item is string => item !== null)])];
}

/** 스킬 폴더들 — 그 자체가 스킬(SKILL.md)이거나 스킬 폴더를 담은 폴더다. 이름은 폴더 이름이다. */
function skillEntries(sources: readonly string[]): { readonly name: string; readonly dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  for (const source of sources) {
    if (!isDirectory(source)) continue;
    if (isFile(path.join(source, "SKILL.md"))) { found.push({ name: path.basename(source), dir: source }); continue; }
    let names: string[];
    try { names = fs.readdirSync(source).sort(); } catch { continue; }
    for (const name of names) {
      const dir = path.join(source, name);
      if (!name.startsWith(".") && isFile(path.join(dir, "SKILL.md"))) found.push({ name, dir });
    }
  }
  return found;
}

/** 커맨드 파일들 — 폴더 바로 아래 `.md` 이거나 선언된 `.md` 파일이다. 이름은 확장자를 뺀 파일 이름이다. */
function commandEntries(sources: readonly string[]): { readonly name: string; readonly file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const source of sources) {
    if (isFile(source)) { if (source.endsWith(".md")) found.push({ name: path.basename(source, ".md"), file: source }); continue; }
    let names: string[];
    try { names = fs.readdirSync(source).sort(); } catch { continue; }
    for (const name of names) {
      const file = path.join(source, name);
      if (!name.startsWith(".") && name.endsWith(".md") && isFile(file)) found.push({ name: name.slice(0, -3), file });
    }
  }
  return found;
}

/** Fleet 플러그인이 싣는 스킬·커맨드 이름 — 같은 이름의 홈 스킬·커맨드는 싣지 않는다. */
function fleetSkillNames(plugins: HomeOverlayFleet["plugins"]): Set<string> {
  const names = new Set<string>();
  for (const plugin of plugins) {
    const manifest = manifestOf(plugin.path);
    for (const { name } of skillEntries(declaredPaths(plugin.path, manifest.skills, "skills"))) names.add(fold(name));
    for (const { name } of commandEntries(declaredPaths(plugin.path, manifest.commands, "commands"))) names.add(fold(name));
  }
  return names;
}

/** 자식이 펼치는 `${이름}` — `headersHelper`는 셸이 읽는 명령이라 넣지 않는다. */
function placeholdersOf(config: ClaudeGatewayExternalMcpServer): string[] {
  const values = config.type === "stdio"
    ? [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})]
    : [config.url, ...Object.values(config.headers ?? {})];
  return values.flatMap((value) => [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!));
}

/**
 * 홈을 읽어 이 세션에 더할 것을 세운다. 임시 플러그인 폴더는 `tempRoot` 아래 새 폴더이고, 돌려준 `release`가 지운다.
 * 세우는 도중 실패하면 그 폴더를 지우고 던진다 — 부른 쪽은 홈 없이 연다.
 */
export async function stageClaudeHomeOverlay(home: ClaudeHomeLocation, fleet: HomeOverlayFleet, tempRoot: string = os.tmpdir()): Promise<ClaudeHomeOverlay> {
  const stage = await fs.promises.mkdtemp(path.join(tempRoot, "fleet-commodore-home-"));
  const release = () => fs.promises.rm(stage, { recursive: true, force: true });
  try {
    return { ...project(home, fleet, stage), release };
  } catch (error) {
    await release();
    throw error;
  }
}

function project(home: ClaudeHomeLocation, fleet: HomeOverlayFleet, stage: string): Omit<ClaudeHomeOverlay, "release"> {
  const skipped: HomeOverlaySkip[] = [];
  const plugins: ClaudeGatewayLocalPlugin[] = [];
  const pluginNames = new Set(fleet.plugins.map((plugin) => fold(plugin.name)));
  const fleetSkills = fleetSkillNames(fleet.plugins);
  const mcpCandidates: { readonly name: string; readonly config: ClaudeGatewayExternalMcpServer }[] = [];

  /** 스테이징 플러그인 하나 — 매니페스트는 이름·버전·설명만, 나머지는 원본 항목으로 가는 링크다. */
  const writePlugin = (name: string, manifest: Record<string, unknown>, links: readonly (readonly [string, string])[]) => {
    const root = path.join(stage, name);
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
    const version = text(manifest.version, 128);
    const description = text(manifest.description, 1000);
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, ...(version ? { version } : {}), ...(description ? { description } : {}) }));
    for (const [relative, target] of links) {
      const link = path.join(root, relative);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === "win32" && isDirectory(target) ? "junction" : undefined);
    }
    plugins.push({ path: root, skipMcp: true });
  };

  // 켜 둔 플러그인 — settings.json 의 enabledPlugins 와 installed_plugins.json(사용자 범위)만 읽는다.
  const settings = readJson(path.join(home.configDir, "settings.json"));
  const installs = readJson(path.join(home.configDir, "plugins", "installed_plugins.json"));
  if (settings === null) skipped.push({ kind: "home", name: "settings.json", reason: "unreadable" });
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins).filter(([, on]) => on === true).map(([id]) => id) : [];
  if (enabled.length && installs !== undefined && (!isRecord(installs) || installs.version !== INSTALL_SCHEMA_VERSION || !isRecord(installs.plugins))) {
    skipped.push({ kind: "home", name: "installed_plugins.json", reason: installs === null ? "unreadable" : "unsupported" });
  } else if (enabled.length && isRecord(installs) && isRecord(installs.plugins)) {
    const records = installs.plugins;
    let count = 0;
    for (const id of enabled) {
      const [plugin, marketplace, ...rest] = id.split("@");
      if (!plugin || !marketplace || rest.length || !segment.test(plugin) || !segment.test(marketplace)) { skipped.push({ kind: "plugin", name: id.slice(0, 200), reason: "name_invalid" }); continue; }
      if (++count > MAX_PLUGINS) { skipped.push({ kind: "plugin", name: id, reason: "limit" }); continue; }
      const record = (Array.isArray(records[id]) ? records[id] as unknown[] : []).find((row): row is Record<string, unknown> => isRecord(row) && row.scope === "user" && typeof row.installPath === "string" && path.isAbsolute(row.installPath));
      if (!record) { skipped.push({ kind: "plugin", name: id, reason: "not_installed" }); continue; }
      const dir = record.installPath as string;
      if (!isDirectory(dir)) { skipped.push({ kind: "plugin", name: id, reason: "missing" }); continue; }
      const name = pluginNameOf(dir, plugin);
      if (pluginNames.has(fold(name))) { skipped.push({ kind: "plugin", name: id, reason: fleet.plugins.some((row) => fold(row.name) === fold(name)) ? "fleet_precedence" : "duplicate" }); continue; }
      pluginNames.add(fold(name));
      const manifest = manifestOf(dir);
      const links: [string, string][] = [];
      const bodies: string[] = [];
      const own = new Set<string>();
      for (const skill of skillEntries(declaredPaths(dir, manifest.skills, "skills"))) {
        const body = readMarkdown(path.join(skill.dir, "SKILL.md"));
        const reason = !segment.test(skill.name) ? "name_invalid" : fleetSkills.has(fold(skill.name)) ? "fleet_precedence" : own.has(fold(skill.name)) ? "duplicate" : declaresHooks(body) ? "hooks" : null;
        if (reason) { skipped.push({ kind: "skill", name: `${name}:${skill.name}`, reason }); continue; }
        own.add(fold(skill.name));
        links.push([path.join("skills", skill.name), skill.dir]);
        bodies.push(body);
      }
      for (const command of commandEntries(declaredPaths(dir, manifest.commands, "commands"))) {
        const body = readMarkdown(command.file);
        const reason = !segment.test(command.name) ? "name_invalid" : fleetSkills.has(fold(command.name)) ? "fleet_precedence" : own.has(fold(command.name)) ? "duplicate" : declaresHooks(body) ? "hooks" : null;
        if (reason) { skipped.push({ kind: "command", name: `${name}:${command.name}`, reason }); continue; }
        own.add(fold(command.name));
        links.push([path.join("commands", `${command.name}.md`), command.file]);
        bodies.push(body);
      }
      // 본문이 `${CLAUDE_PLUGIN_ROOT}/docs/…`처럼 가리키는 루트 항목 — 스테이징 루트로 펼쳐지므로 같은 자리에 잇는다.
      const referenced = new Set(bodies.flatMap((body) => [...body.matchAll(ROOT_REFERENCE)].map((match) => match[1]!)));
      for (const entry of [...referenced].sort()) {
        const target = path.join(dir, entry);
        if (entry.startsWith(".") || BEHAVIOR_ENTRIES.has(entry) || !segment.test(entry) || !staysInside(dir, target)) continue;
        links.push([entry, target]);
      }
      const servers = pluginMcpServers(dir, name);
      // 스킬·커맨드·MCP 가 없는 플러그인(LSP 전용 등)은 실을 것이 없다.
      if (!own.size && !servers.length) { skipped.push({ kind: "plugin", name: id, reason: "unsupported" }); continue; }
      if (own.size) writePlugin(name, manifest, links);
      for (const server of servers) mcpCandidates.push({ name: server.name, config: server.config });
    }
  }

  // 홈 스킬 — `skills/<이름>/SKILL.md`. 한 플러그인(`home-skills`)으로 모아 스킬 항목마다 링크한다.
  const skillLinks: [string, string][] = [];
  const homeSkills = new Set<string>();
  for (const skill of skillEntries([path.join(home.configDir, "skills")])) {
    const reason = !segment.test(skill.name) ? "name_invalid" : homeSkills.size >= MAX_SKILLS ? "limit" : fleetSkills.has(fold(skill.name)) ? "fleet_precedence" : declaresHooks(readMarkdown(path.join(skill.dir, "SKILL.md"))) ? "hooks" : null;
    if (reason) { skipped.push({ kind: "skill", name: skill.name, reason }); continue; }
    homeSkills.add(fold(skill.name));
    skillLinks.push([path.join("skills", skill.name), skill.dir]);
  }
  if (skillLinks.length) {
    let name = SKILLS_PLUGIN;
    for (let n = 2; pluginNames.has(fold(name)); n++) name = `${SKILLS_PLUGIN}-${n}`;
    pluginNames.add(fold(name));
    writePlugin(name, {}, skillLinks);
  }

  // 사용자 범위 MCP 서버 — 전역 설정 파일의 최상위 `mcpServers`. 프로젝트별(`projects`) 선언은 읽지 않는다.
  const config = readJson(home.configFile);
  if (config === null) skipped.push({ kind: "home", name: path.basename(home.configFile), reason: "unreadable" });
  const declared = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : {};
  const userServers: typeof mcpCandidates = [];
  for (const [name, raw] of Object.entries(declared)) {
    const converted = isRecord(raw) && (raw.type === undefined || ["stdio", "http", "sse", "ws"].includes(raw.type as string)) ? externalMcpServerOf(raw) : null;
    if (!converted) { skipped.push({ kind: "mcp", name: name.slice(0, 200), reason: "unsupported" }); continue; }
    userServers.push({ name, config: converted });
  }

  // 정규화한 서버 이름(자식이 도구 이름에 쓰는 몫)으로 겹침을 가린다 — 호스트 예약 묶음과 Fleet 서버가 먼저다.
  const prefix = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fleetPrefixes = new Set([...fleet.reservedGroups, ...fleet.plugins.flatMap((plugin) => Object.keys(plugin.mcpServers))].map(prefix));
  const taken = new Set(fleetPrefixes);
  const mcpServers: Record<string, ClaudeGatewayExternalMcpServer> = {};
  const env: Record<string, string> = {};
  const lift = (value: string): string => {
    if (value.includes("${")) return value;
    const key = `${LIFTED_ENV_PREFIX}${Object.keys(env).length}`;
    env[key] = value;
    return `\${${key}}`;
  };
  for (const { name, config: server } of [...userServers, ...mcpCandidates]) {
    const reason = !MCP_NAME.test(name) ? "name_invalid"
      : fleetPrefixes.has(prefix(name)) ? "fleet_precedence"
        : taken.has(prefix(name)) ? "duplicate"
          : Object.keys(mcpServers).length >= MAX_MCP_SERVERS ? "limit"
            : placeholdersOf(server).some((key) => RESERVED_PLACEHOLDER.test(key)) ? "reserved_placeholder" : null;
    if (reason) { skipped.push({ kind: "mcp", name: name.slice(0, 200), reason }); continue; }
    taken.add(prefix(name));
    mcpServers[name] = server.type === "stdio"
      ? { ...server, ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, lift(value)])) } : {}) }
      : { ...server, ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, lift(value)])) } : {}) };
  }

  return { plugins, mcpServers, env, skipped };
}
