import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClaudeGatewayExternalMcpServer, ClaudeGatewayLocalPlugin } from "@fleet-console/agent-runtime/claude";

import { COMPONENT_KEYS, externalMcpServerOf, manifestOf, pluginMcpServers, pluginNameOf, type ResolvedPlugin } from "./plugins.js";

/**
 * 사령관 세션에 사람의 실제 Claude 홈에서 MCP 서버·스킬·켜 둔 플러그인만 더한다(+@). 자식의 `CLAUDE_CONFIG_DIR`는
 * 그대로 세션의 임시 홈이고 `settingSources: []`·`strictMcpConfig`도 그대로다 — 홈은 여기서 읽기만 한다.
 *
 * 홈의 CLAUDE.md·훅·권한·env·모델·auto-memory는 싣지 않는다. settings.json 에서는 `enabledPlugins`만,
 * `.claude.json` 에서는 최상위 `mcpServers`(사용자 범위)만 읽는다.
 *
 * 켜 둔 플러그인은 훅만 뺀 채 그대로 싣는다 — 스킬·커맨드(중첩 포함)·에이전트·LSP·지원 파일(bin 등)·선언된 구성 경로와
 * strict:false marketplace 항목의 구성 요소. 설치 폴더를 그대로 넘기면 훅도 실리므로, 세션 전용 임시 폴더에 같은 모양을
 * 링크로 다시 세우고 훅이 들어오는 자리만 바꾼다: plugin.json 은 marketplace 항목과 합쳐 `hooks` 를 뺀 것으로 쓰고,
 * 기본 훅 파일(`hooks/hooks.json`)은 잇지 않으며, 머리말(frontmatter)에 `hooks`를 둔 스킬·에이전트·커맨드는 그 키만 뺀
 * 사본으로 둔다. 키만 뺄 수 없는 머리말이면 그 파일을 싣지 않는다. 링크는 설치 폴더 안에 머무는 항목만 잇는다.
 * 플러그인 MCP 는 strictMcpConfig 가 막으므로 선언을 옮겨 호스트가 연다.
 *
 * 이름이 겹치면 Fleet 이 우선한다 — 플러그인 이름, 스킬·커맨드 이름, 정규화한 MCP 서버 이름, 호스트 예약 도구 묶음.
 * 읽을 수 없거나 형식을 모르는 홈 데이터는 그 항목만 빼고 이유 코드를 남긴다. 어떤 경우에도 사령관 기동을 막지 않는다.
 * Console 은 여기서 아무것도 실행하지 않는다 — 싣고 실행하는 쪽은 세션의 Claude 자식이다.
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
  readonly kind: "home" | "plugin" | "skill" | "command" | "agent" | "file" | "mcp";
  readonly name: string;
  readonly reason: "fleet_precedence" | "duplicate" | "unreadable" | "unsupported" | "not_installed" | "missing" | "hooks" | "outside" | "cycle" | "name_invalid" | "reserved_placeholder" | "limit";
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
const MAX_MARKDOWN_FILES = 2_000;
/** 링크 검사를 위해 훑는 원본 항목의 상한 — 넘으면 그 플러그인·스킬은 안을 다 확인할 수 없어 싣지 않는다. */
const MAX_TREE_ENTRIES = 50_000;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const LIFTED_ENV_PREFIX = "FLEET_HOME_MCP_";
const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const MCP_NAME = /^[a-zA-Z0-9_.:-]+$/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
/** 실행 환경·Console·게이트웨이 내부 이름 — 홈 선언이 이 값을 외부 서버로 끌어가지 못하게 그런 선언은 뺀다. */
const RESERVED_PLACEHOLDER = /^(?:FLEET|CLAUDE|ANTHROPIC)_/;
/**
 * Claude Code 가 스킬·에이전트·커맨드 머리말을 떼는 식(CLI 2.1.318 판독) — 잡힌 블록을 YAML 로 읽는다. 닫는 `---`는 줄 머리가
 * 아니어도 처음 나온 곳이다. 같은 식으로 떼어야 자식이 읽는 그 블록을 본다.
 */
const CLI_FRONTMATTER = /^(---\s*\n)([\s\S]*?)(---\s*\n?)/;
/** YAML 이 `hooks` 키로 읽을 수 있는 자리 — 줄 머리·흐름 매핑·따옴표·태그·앵커 뒤. 값 속의 낱말은 잡지 않는다. */
const HOOKS_KEY = /(?:^|[\s{,[])["']?hooks["']?[ \t]*:/m;
/** 줄 머리(들여쓰기 없음)의 블록 `hooks:` 키 — 이것만 줄째로 뺄 수 있다. */
const TOP_LEVEL_HOOKS = /^(["']?)hooks\1[ \t]*:/;

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

/** 링크를 푼 실제 경로도 그 폴더 안인가. 없는 파일은 밖과 같다. */
function staysInside(root: string, candidate: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch { return false; }
}

/**
 * `root` 의 실제 트리(링크를 따라가지 않는다)에서 실제 경로가 `root` 밖이거나 끊긴 링크를 품은 폴더들의 실제 경로.
 * 이런 폴더는 통째로 링크하면 그 안의 링크로 밖에 닿으므로, 다시 세울 때 내려가서 그 링크만 뺀다. 상한을 넘으면 null.
 */
function foldersWithEscapingLinks(root: string): Set<string> | null {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return new Set(); }
  const tainted = new Set<string>();
  let seen = 0;
  const pending = [realRoot];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > MAX_TREE_ENTRIES) return null;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (!entry.isSymbolicLink() || staysInside(realRoot, file)) continue;
      for (let up = dir; up === realRoot || up.startsWith(realRoot + path.sep); up = path.dirname(up)) { tainted.add(up); if (up === realRoot) break; }
    }
  }
  return tainted;
}

const realpathOf = (file: string): string => { try { return fs.realpathSync(file); } catch { return file; } };

/**
 * 머리말이 `hooks` 키를 둘 수 있는가 — YAML 이 같은 키로 읽는 모양을 모두 본다: 줄 머리·흐름 매핑·따옴표·태그·앵커 뒤의
 * `hooks:`, 이스케이프로 적은 큰따옴표 키, 명시 키(`?`)와 별칭(`*`) 키. 값 속의 낱말이나 이스케이프는 키가 아니다.
 */
function mayDeclareHooks(block: string): boolean {
  if (/(?:^|[\s{,[?])"(?:[^"\\]|\\[\s\S])*\\(?:[^"\\]|\\[\s\S])*"[ \t]*:/m.test(block)) return true;
  const indirect = /^[ \t]*\?(?:[ \t]|$)/m.test(block) || /(?:^|[\s{,[])\*\S/m.test(block);
  if (indirect && (block.includes("hooks") || block.includes("\\"))) return true;
  return block.includes("hooks") && HOOKS_KEY.test(block);
}

/**
 * 마크다운 파일 하나를 자식이 읽을 모양으로. `link`는 원본 그대로, `write`는 머리말의 `hooks`만 뺀 사본, `omit`은 훅을
 * 떼어 낼 수 없어 싣지 않는 것이다. 줄 머리의 블록 키만 뺀다 — 뺀 뒤에도 키 자리에 `hooks`가 보이면 싣지 않는다.
 */
function withoutFrontmatterHooks(file: string): { readonly kind: "link" } | { readonly kind: "write"; readonly text: string } | { readonly kind: "omit" } {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_MARKDOWN_BYTES) {
      // 다 읽지 않은 머리말은 판정할 수 없다 — 머리말로 시작하면 싣지 않는다.
      const fd = fs.openSync(file, "r");
      try { const head = Buffer.alloc(8); fs.readSync(fd, head, 0, 8, 0); return head.toString("utf8").replace(/^﻿/, "").startsWith("---") ? { kind: "omit" } : { kind: "link" }; }
      finally { fs.closeSync(fd); }
    }
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch { return { kind: "link" }; }
  const match = CLI_FRONTMATTER.exec(text);
  if (!match || !mayDeclareHooks(match[2]!)) return { kind: "link" };
  const lines = match[2]!.split(/(?<=\n)/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!TOP_LEVEL_HOOKS.test(lines[index]!)) { kept.push(lines[index]!); continue; }
    // 그 키의 값은 뒤따르는 들여쓴 줄·빈 줄이다.
    while (index + 1 < lines.length && /^(?:[ \t]|\r?\n|$)/.test(lines[index + 1]!)) index++;
  }
  const block = kept.join("");
  if (mayDeclareHooks(block)) return { kind: "omit" };
  return { kind: "write", text: `${match[1]}${block}${match[3]}${text.slice(match[0].length)}` };
}

/** 선언된 경로 목록(문자열·배열)과 기본 자리 — 플러그인 안에 머무는 것만. */
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

/** 커맨드·에이전트 파일들 — 폴더 아래(중첩 포함)의 `.md` 이거나 선언된 `.md` 파일이다. 이름은 확장자를 뺀 파일 이름이다. */
function markdownEntries(sources: readonly string[]): { readonly name: string; readonly file: string }[] {
  const found: { name: string; file: string }[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || found.length >= MAX_MARKDOWN_FILES) continue;
      const file = path.join(dir, name);
      if (name.endsWith(".md") && isFile(file)) found.push({ name: name.slice(0, -3), file });
      else if (depth < 8 && isDirectory(file)) walk(file, depth + 1);
    }
  };
  for (const source of sources) {
    if (isFile(source)) { if (source.endsWith(".md")) found.push({ name: path.basename(source, ".md"), file: source }); }
    else walk(source, 0);
  }
  return found;
}

/** Fleet 플러그인이 싣는 스킬·커맨드 이름 — 같은 이름의 홈 스킬·커맨드는 싣지 않는다. */
function fleetSkillNames(plugins: HomeOverlayFleet["plugins"]): Set<string> {
  const names = new Set<string>();
  for (const plugin of plugins) {
    const manifest = manifestOf(plugin.path);
    for (const { name } of skillEntries(declaredPaths(plugin.path, manifest.skills, "skills"))) names.add(fold(name));
    for (const { name } of markdownEntries(declaredPaths(plugin.path, manifest.commands, "commands"))) names.add(fold(name));
  }
  return names;
}

/** 두 구성 요소 선언을 합친다 — 표는 키 단위로, 경로는 목록으로. */
function combine(base: unknown, extra: unknown): unknown {
  if (base === undefined) return extra;
  if (isRecord(base) && isRecord(extra)) return { ...base, ...extra };
  const list = (value: unknown) => (Array.isArray(value) ? value : [value]);
  return [...new Set([...list(base), ...list(extra)])];
}

/**
 * 홈 marketplace 의 그 플러그인 항목. strict:false 항목은 설치본 대신 구성 요소를 선언하고, 그 밖의 항목도 plugin.json 과
 * 함께 읽힌다. 찾지 못하면 null.
 */
function marketplaceEntry(configDir: string, plugin: string, marketplace: string): Record<string, unknown> | null {
  const known = readJson(path.join(configDir, "plugins", "known_marketplaces.json"));
  const location = isRecord(known) && isRecord(known[marketplace]) ? known[marketplace].installLocation : undefined;
  if (typeof location !== "string" || !path.isAbsolute(location)) return null;
  const document = readJson(path.join(location, ".claude-plugin", "marketplace.json"));
  const entries = isRecord(document) && Array.isArray(document.plugins) ? document.plugins : [];
  return entries.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === plugin) ?? null;
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

/** 원본의 자리별 처리 — 사본(`text`)을 쓰거나, 싣지 않거나(null). 나머지는 링크다. */
type Overrides = Map<string, { readonly text: string } | null>;

function project(home: ClaudeHomeLocation, fleet: HomeOverlayFleet, stage: string): Omit<ClaudeHomeOverlay, "release"> {
  const skipped: HomeOverlaySkip[] = [];
  const plugins: ClaudeGatewayLocalPlugin[] = [];
  const pluginNames = new Set(fleet.plugins.map((plugin) => fold(plugin.name)));
  const fleetSkills = fleetSkillNames(fleet.plugins);
  const mcpCandidates: { readonly name: string; readonly config: ClaudeGatewayExternalMcpServer }[] = [];

  /**
   * `source`를 `target`에 링크로 다시 세운다. 바꿀 자리가 아래에 있는 폴더와, 안에 `root` 밖으로 가는 링크를 품은 폴더
   * (`tainted`)만 실제 폴더로 만들고 내려간다 — 그래서 어느 깊이의 링크로도 `root` 밖에 닿지 않는다. 밖을 가리키는 항목과
   * 돌아 들어오는 폴더 링크는 `label`로 이름 붙여 뺀다.
   */
  const mirror = (root: string, source: string, target: string, overrides: Overrides, label: string, tainted: ReadonlySet<string>) => {
    const expand = new Set<string>();
    for (const file of overrides.keys()) for (let dir = path.dirname(file); dir.startsWith(source + path.sep) || dir === source; dir = path.dirname(dir)) { expand.add(dir); if (dir === source) break; }
    const walk = (from: string, to: string, ancestors: ReadonlySet<string>) => {
      fs.mkdirSync(to, { recursive: true });
      let names: string[];
      try { names = fs.readdirSync(from).sort(); } catch { return; }
      for (const name of names) {
        const entry = path.join(from, name);
        const destination = path.join(to, name);
        const relative = path.relative(source, entry);
        if (overrides.has(entry)) {
          const replaced = overrides.get(entry);
          if (replaced) fs.writeFileSync(destination, replaced.text);
          continue;
        }
        if (!staysInside(root, entry)) { skipped.push({ kind: "file", name: `${label}/${relative}`, reason: "outside" }); continue; }
        const real = realpathOf(entry);
        if (isDirectory(entry) && (expand.has(entry) || tainted.has(real))) {
          if (ancestors.has(real)) { skipped.push({ kind: "file", name: `${label}/${relative}`, reason: "cycle" }); continue; }
          walk(entry, destination, new Set([...ancestors, real]));
          continue;
        }
        fs.symlinkSync(entry, destination, process.platform === "win32" && isDirectory(entry) ? "junction" : undefined);
      }
    };
    walk(source, target, new Set([realpathOf(source)]));
  };

  /** 스킬·에이전트·커맨드 마크다운의 머리말 훅을 떼어 낼 자리로 적는다. 떼어 낼 수 없으면 싣지 않는다. */
  const stripHooks = (overrides: Overrides, file: string, kind: HomeOverlaySkip["kind"], name: string) => {
    const result = withoutFrontmatterHooks(file);
    if (result.kind === "write") overrides.set(file, { text: result.text });
    else if (result.kind === "omit") { overrides.set(file, null); skipped.push({ kind, name, reason: "hooks" }); }
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

      // plugin.json 과 marketplace 항목의 구성 요소를 합치고(Fleet 등록부가 strict:false 를 싣는 방식과 같은 키) `hooks`만 뺀다.
      const own = manifestOf(dir);
      const entry = marketplaceEntry(home.configDir, plugin, marketplace);
      const manifest: Record<string, unknown> = { ...own, name };
      for (const key of COMPONENT_KEYS) if (entry && entry[key] !== undefined) manifest[key] = combine(manifest[key], entry[key]);
      if (manifest.version === undefined && typeof entry?.version === "string") manifest.version = entry.version;
      if (manifest.description === undefined && typeof entry?.description === "string") manifest.description = entry.description;
      delete manifest.hooks;

      const overrides: Overrides = new Map();
      overrides.set(path.join(dir, ".claude-plugin"), null);
      overrides.set(path.join(dir, "hooks", "hooks.json"), null);
      // CLI 가 설치본의 사용 중 표시로 쓰는 파일 — 링크하면 자식의 쓰기가 홈 캐시에 닿는다.
      overrides.set(path.join(dir, ".in_use"), null);
      // 플러그인 settings.json 이 훅을 들면 그 키만 뺀 사본을 둔다.
      const pluginSettings = readJson(path.join(dir, "settings.json"));
      if (isRecord(pluginSettings) && pluginSettings.hooks !== undefined) {
        const { hooks: _hooks, ...rest } = pluginSettings;
        overrides.set(path.join(dir, "settings.json"), { text: JSON.stringify(rest) });
      }
      for (const skill of skillEntries(declaredPaths(dir, manifest.skills, "skills"))) {
        if (fleetSkills.has(fold(skill.name))) { overrides.set(skill.dir, null); skipped.push({ kind: "skill", name: `${name}:${skill.name}`, reason: "fleet_precedence" }); continue; }
        stripHooks(overrides, path.join(skill.dir, "SKILL.md"), "skill", `${name}:${skill.name}`);
      }
      for (const command of markdownEntries(declaredPaths(dir, manifest.commands, "commands"))) {
        if (fleetSkills.has(fold(command.name))) { overrides.set(command.file, null); skipped.push({ kind: "command", name: `${name}:${command.name}`, reason: "fleet_precedence" }); continue; }
        stripHooks(overrides, command.file, "command", `${name}:${command.name}`);
      }
      for (const agent of markdownEntries(declaredPaths(dir, manifest.agents, "agents"))) stripHooks(overrides, agent.file, "agent", `${name}:${agent.name}`);

      const tainted = foldersWithEscapingLinks(dir);
      if (!tainted) { skipped.push({ kind: "plugin", name: id, reason: "limit" }); continue; }
      const root = path.join(stage, name);
      mirror(dir, dir, root, overrides, name, tainted);
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      plugins.push({ path: root, skipMcp: true });
      for (const server of pluginMcpServers(dir, name, manifest)) mcpCandidates.push({ name: server.name, config: server.config });
    }
  }

  // 홈 스킬 — `skills/<이름>/SKILL.md`. 한 플러그인(`home-skills`)으로 모아 스킬마다 링크한다. 머리말 훅이 있으면 그 스킬만 다시 세운다.
  const skillsRoot = path.join(stage, `.${SKILLS_PLUGIN}`);
  const homeSkills: string[] = [];
  for (const skill of skillEntries([path.join(home.configDir, "skills")])) {
    const reason = !segment.test(skill.name) ? "name_invalid" : homeSkills.length >= MAX_SKILLS ? "limit" : fleetSkills.has(fold(skill.name)) ? "fleet_precedence" : null;
    if (reason) { skipped.push({ kind: "skill", name: skill.name, reason }); continue; }
    const overrides: Overrides = new Map();
    stripHooks(overrides, path.join(skill.dir, "SKILL.md"), "skill", skill.name);
    const target = path.join(skillsRoot, "skills", skill.name);
    if (overrides.get(path.join(skill.dir, "SKILL.md")) === null) continue;
    // 스킬 폴더 자체는 사람이 홈에 건 링크일 수 있다. 그 안의 링크는 그 스킬의 실제 폴더 밖에 닿지 않아야 한다.
    const tainted = foldersWithEscapingLinks(skill.dir);
    if (!tainted) { skipped.push({ kind: "skill", name: skill.name, reason: "limit" }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (overrides.size || tainted.size) mirror(skill.dir, skill.dir, target, overrides, skill.name, tainted);
    else fs.symlinkSync(skill.dir, target, process.platform === "win32" ? "junction" : undefined);
    homeSkills.push(skill.name);
  }
  if (homeSkills.length) {
    let name = SKILLS_PLUGIN;
    for (let n = 2; pluginNames.has(fold(name)); n++) name = `${SKILLS_PLUGIN}-${n}`;
    pluginNames.add(fold(name));
    const root = path.join(stage, name);
    fs.renameSync(skillsRoot, root);
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    plugins.push({ path: root, skipMcp: true });
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
