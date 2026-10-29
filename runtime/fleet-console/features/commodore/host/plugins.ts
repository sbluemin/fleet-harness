import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { OwnedProcessPort } from "@fleet-console/process";
import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";

import { CommodoreStoreError } from "./errors.js";
import {
  MAX_CUSTOM_MARKETPLACES,
  MAX_PLUGIN_CARD_DESCRIPTION,
  MAX_PLUGIN_DETAIL_DESCRIPTION,
  MAX_PLUGIN_ICON_BYTES,
  MAX_PLUGIN_KEYWORDS,
  MAX_PLUGIN_PARTS,
  MAX_PLUGIN_README_BYTES,
  PRESET_MARKETPLACES,
  pluginIdSchema,
  splitPluginId,
  type MarketplaceErrorCode,
  type MarketplaceSourceKind,
  type MarketplaceView,
  type PluginCatalogEntry,
  type PluginCatalogView,
  type PluginComponents,
  type PluginContents,
  type PluginDetail,
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
  /**
   * 사령관 state.json 의 `plugins`(`plugin@marketplace`)를 모두 모은 것. 기본 제공의 처음 켜짐을 한 번 정할 때만 읽는다.
   * 미리보기(inspect)로 Fleet 홈에 받아 둔 플러그인은 여기 없다. 생략하면 고른 플러그인이 없는 것으로 친다.
   */
  readonly selectedPlugins?: () => readonly string[];
}

/** 플러그인 단위 업데이트 결과 — 성공한 CLI 가 알린 이전·새 버전과 바뀐 카탈로그. */
export interface PluginUpdateResult {
  readonly outcome: "updated" | "up_to_date";
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly view: PluginCatalogView;
}

/** 세션이 싣는 플러그인 하나 — 로컬 경로와, 호스트가 대신 소유할 MCP 선언. */
export interface ResolvedPlugin {
  readonly id: string;
  readonly path: string;
  /**
   * 서버 이름은 Claude Code 가 `--plugin-dir` 플러그인에 붙이는 `plugin:<플러그인>:<서버>` 그대로다. 값의 `${VAR}`는
   * 자리표시 그대로 두고 키는 `pluginEnv`로 자식 환경에 얹는다 — 그래야 목표 세션(자식이 플러그인을 직접 읽는다)과
   * 이름·`{type,url,headers}`가 글자 그대로 같아 CLI 보안 저장소의 OAuth 토큰을 함께 쓰고, 키가 argv 에 실리지 않는다.
   */
  readonly mcpServers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
  /** 그 선언의 `${VAR}`에 채울, 사람이 Console 에 넣은 키. 세션 자식의 환경에만 얹는다. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * 플러그인 MCP 서버 하나의 인증 방식. `oauth`는 원격 서버가 표준 401 로 요구하면 Claude Code 가 대신 로그인하는 서버,
 * `key`는 선언이 `${VAR}`로 사람의 키를 받는 서버다. 헤더에 고정 자격이 있거나 키 없는 stdio 는 목록에 없다.
 */
export interface PluginAuthServer {
  readonly pluginId: string;
  /** 플러그인 선언의 서버 키(`.mcp.json`의 이름) — 화면이 쓰는 이름. */
  readonly server: string;
  /** 세션이 쓰는 서버 이름(`plugin:<플러그인>:<서버>`). */
  readonly name: string;
  readonly config: ClaudeGatewayExternalMcpServer;
  readonly mode: "oauth" | "key";
  /** 이 서버가 받는 키 이름(기본값 없는 `${VAR}`). */
  readonly keys: readonly string[];
  /** 아직 값이 없는 키 — Console 에 넣은 것도, Console 환경에 있는 것도 아니다. */
  readonly missing: readonly string[];
  /** Console 에 넣어 둔 키. */
  readonly saved: readonly string[];
  /** 선언이 기본값 없이 가리키지만 키로 받지 않는 실행 환경 이름(예: `${FLEET_X}`) 중 Console 환경에도 없는 것 — 채울 길이 없다. */
  readonly unsupported: readonly string[];
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
  /** 마지막으로 받기를 시도한 시각 — 실패한 기본 제공을 목록 읽기마다 다시 받지 않게 한다. */
  readonly attemptedAt?: number;
}

interface Registry {
  readonly version: 1;
  readonly marketplaces: readonly RegistryMarketplace[];
  /** 실행 명령이 있는 플러그인을 사람이 신뢰한 버전. 버전이 바뀌면 다시 묻는다. */
  readonly trusted: Readonly<Record<string, string>>;
}

interface CliResult {
  readonly outcome?: string;
  readonly updateOutcome?: string;
  readonly oldVersion?: string;
  readonly newVersion?: string;
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

/** `${NAME}`·`${NAME:-기본값}` — Claude Code 가 MCP 선언에서 펼치는 자리표시. `${user_config.*}`는 이름 문법이 달라 걸리지 않는다. */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(:-[^}]*)?\}/g;
/** 플러그인이 아니라 실행 환경이 정하는 이름 — 키로 받지도 자식 환경에 얹지도 않는다. */
const RESERVED_KEY = /^(?:PATH|HOME|SHELL|USER|LOGNAME|PWD|TMPDIR|TEMP|TMP|NODE_OPTIONS|NODE_PATH|(?:LD|DYLD|CLAUDE|ANTHROPIC|FLEET|FLEET_CONSOLE|NPM|npm)_[A-Za-z0-9_]*)$/;
export const MAX_PLUGIN_KEY_BYTES = 8_192;
const KEYS_FILE = "keys.json";
const PRESET_REFRESH_MS = 24 * 60 * 60_000;
/**
 * 기본 켜짐을 한 번 정했다는 표시. registry 의 version 이 아니다.
 * 옛 빌드는 registry.json 을 `{ version, marketplaces, trusted }` 로만 다시 쓰지만 이 파일은 건드리지 않는다.
 */
const PRESET_ACTIVATION_FILE = "preset-activation.json";
/** 실패한 기본 제공을 목록 읽기로 다시 받기까지의 간격. 「갱신」 단추는 이 간격과 무관하게 바로 받는다. */
const PRESET_RETRY_MS = 10 * 60_000;
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
  // ssh 는 scp 형식(`user@host:path`)만 Claude CLI 가 받는다 — `ssh://` URL 은 invalid_source 로 거절된다(CLI 2.1.310 실측).
  // 포트 없는 `ssh://user@host/path` 는 같은 뜻의 scp 형식으로 바꿔 넘기고, 포트가 있는 것은 그 형식으로 옮길 수 없어 받지 않는다.
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[A-Za-z0-9._/~-]+?(?:\.git)?$/;
  const sshUrl = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(\/[A-Za-z0-9._/~-]+?(?:\.git)?)$/;
  {
    const [base, inline] = split(value, "#");
    const converted = sshUrl.exec(base);
    const cliBase = converted ? `${converted[1]}@${converted[2]}:${converted[3]}` : scp.test(base) ? base : null;
    if (cliBase) { const ref = pick(inline); if (ref === null) return null; return { kind: "git", locator: base, ...(ref ? { ref } : {}), cliSource: ref ? `${cliBase}#${ref}` : cliBase }; }
    if (base.startsWith("ssh://")) return null;
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

/** 어휘로 안이어도, 링크를 푼 실제 경로가 폴더 밖이면 아니다. 없는 파일은 밖과 같다. */
function staysInside(root: string, candidate: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try { realRoot = fs.realpathSync(root); realCandidate = fs.realpathSync(candidate); } catch { return false; }
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep);
}

/**
 * 플러그인 폴더 안의 텍스트만 상한까지 읽는다. 링크가 폴더 밖을 가리키거나 널 바이트가 있으면 없는 파일로 친다.
 * 반환 문자열에는 경로가 없다.
 */
function readContainedText(dir: string, relative: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } | null {
  const lexical = inside(dir, relative);
  if (!lexical || !staysInside(dir, lexical)) return null;
  let realFile: string;
  try { realFile = fs.realpathSync(lexical); } catch { return null; }
  let stat: fs.Stats;
  try { stat = fs.statSync(realFile); } catch { return null; }
  if (!stat.isFile() || stat.size <= 0) return null;
  const truncated = stat.size > maxBytes;
  let fd: number | null = null;
  try {
    fd = fs.openSync(realFile, "r");
    const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
    const got = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const slice = bytes.subarray(0, got);
    if (slice.includes(0)) return null;
    const text = slice.toString("utf8").replace(/^﻿/, "").trim();
    return text ? { text, truncated } : null;
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

const README_NAMES = ["README.md", "README.markdown"] as const;

/** 선언된 상대 경로, 없으면 README 파일. URL·스킴은 받지 않는다 — 상세 조회는 네트워크로 읽지 않는다. */
function readmeOf(dir: string, declared: readonly unknown[]): { readonly text: string; readonly truncated: boolean } | undefined {
  const relatives: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const relative = value.trim();
    if (!relative || /^[a-z][a-z0-9+.-]*:/i.test(relative) || relatives.includes(relative)) return;
    relatives.push(relative);
  };
  for (const value of declared) push(value);
  for (const name of README_NAMES) push(name);
  for (const relative of relatives) {
    const found = readContainedText(dir, relative, MAX_PLUGIN_README_BYTES);
    if (found) return found;
  }
  return undefined;
}

/** 폴더 안 이름만. 밖을 가리키는 링크는 건너뛴다. 경로는 이름에 넣지 않는다. */
function partNames(root: string, dirs: readonly string[], accept: (name: string, full: string) => boolean): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const label = name.replace(/\.md$/i, "").trim().slice(0, 120);
    if (!label || seen.has(label) || names.length >= MAX_PLUGIN_PARTS) return;
    seen.add(label);
    names.push(label);
  };
  for (const dir of dirs) {
    if (!staysInside(root, dir)) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (stat.isFile()) { if (accept(path.basename(dir), dir)) push(path.basename(dir)); continue; }
    if (accept(path.basename(dir), dir) && fs.existsSync(path.join(dir, "SKILL.md"))) { push(path.basename(dir)); continue; }
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (!staysInside(root, full)) continue;
      if (accept(name, full)) push(name);
    }
  }
  return names;
}

const ICON_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** 확장자가 말하는 형식과 실제 바이트가 맞는가 — 이름만 그림인 파일을 그림으로 내주지 않는다. */
function looksLike(mime: string, bytes: Buffer): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  switch (mime) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a";
    case "image/webp": return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/svg+xml": return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, ""));
    default: return false;
  }
}

/**
 * plugin.json `icon` 이 가리키는 그림 파일. 어휘로 플러그인 폴더 안인지 본 뒤, 실제 경로(심볼릭 링크를 푼)로 다시 폴더 안인지 보고,
 * 정해진 그림 형식·크기·바이트 머리만 받는다. 하나라도 어긋나면 아이콘이 없는 것으로 친다.
 */
function iconFileOf(dir: string, declared: unknown): { readonly file: string; readonly mime: string } | null {
  const lexical = inside(dir, declared);
  if (!lexical) return null;
  const mime = ICON_TYPES[path.extname(lexical).toLowerCase()];
  if (!mime) return null;
  let realDir: string;
  let realFile: string;
  try { realDir = fs.realpathSync(dir); realFile = fs.realpathSync(lexical); } catch { return null; }
  if (!realFile.startsWith(realDir + path.sep)) return null;
  try {
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PLUGIN_ICON_BYTES) return null;
  } catch { return null; }
  return { file: realFile, mime };
}

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const personName = (value: unknown): string | undefined => text(typeof value === "string" ? value : isRecord(value) ? value.name : undefined, 120);
const webAddress = (value: unknown): string | undefined => {
  const raw = text(value, 2048);
  if (!raw) return undefined;
  try { const url = new URL(raw); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};
const licenseOf = (value: unknown): string | undefined => text(typeof value === "string" ? value : isRecord(value) ? value.type ?? value.name : undefined, 80);
const repositoryOf = (value: unknown): string | undefined => webAddress(typeof value === "string" ? value : isRecord(value) ? value.url : undefined);
const keywordsOf = (value: unknown): readonly string[] | undefined => {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const words: string[] = [];
  for (const item of list) {
    const word = text(item, 40);
    if (!word || words.includes(word)) continue;
    words.push(word);
    if (words.length >= MAX_PLUGIN_KEYWORDS) break;
  }
  return words.length ? words : undefined;
};

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

  const activationFile = path.join(options.root, PRESET_ACTIVATION_FILE);
  const activationSettled = (): boolean => {
    const raw = readJson(activationFile);
    return isRecord(raw) && raw.settled === true;
  };
  const writeActivation = (): void => {
    fs.mkdirSync(options.root, { recursive: true });
    const tmp = `${activationFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ settled: true })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, activationFile);
  };
  /** 고른 플러그인이 가리키는 기본 제공 이름. 형식이 아닌 값과 기본 제공이 아닌 마켓은 설치로 치지 않는다. */
  const selectedPresetNames = (): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const id of options.selectedPlugins?.() ?? []) {
      if (!pluginIdSchema.safeParse(id).success) continue;
      const marketplace = splitPluginId(id).marketplace;
      if (PRESET_MARKETPLACES.some((preset) => preset.name === marketplace)) names.add(marketplace);
    }
    return names;
  };
  /**
   * 이미 있는 기본 제공 행의 켜짐을 한 번만 맞춘다. 기본으로 꺼 둘 마켓은, 어느 사령관이든 그 마켓 플러그인을 골랐으면
   * 그대로 두고(켜져 있었으면 켜진 채), 아니면 끈다. 기본으로 켜 둘 마켓과 사람이 이미 끈 행은 건드리지 않는다.
   * 표시를 남긴 뒤에는 다시 쓰지 않는다. 고른 목록을 읽지 못하면 표시도 남기지 않고 다음 목록 읽기에서 다시 본다.
   */
  const settlePresetActivation = (): void => {
    if (activationSettled()) return;
    let keep: ReadonlySet<string>;
    try { keep = selectedPresetNames(); }
    catch { return; }
    const current = readRegistry();
    const marketplaces = current.marketplaces.map((row) => {
      const preset = PRESET_MARKETPLACES.find((item) => item.name === row.name);
      if (!preset || preset.enabled || !row.enabled || keep.has(row.name)) return row;
      return { ...row, enabled: false, ...(row.status === "syncing" ? { status: "ready" as const } : {}) };
    });
    if (marketplaces.some((row, index) => row !== current.marketplaces[index])) writeRegistry({ ...current, marketplaces });
    writeActivation();
  };

  const runCli = async (args: readonly string[]): Promise<CliResult> => {
    // Claude Code CLI 를 찾지 못한 것도 CLI 실패 하나로 돌려준다 — 던지면 받는 중(syncing)으로 적어 둔 상태가 그대로 남고,
    // 화면은 받는 중인 동안 2초마다 목록을 다시 읽으며 그때마다 기본 제공 받기를 또 시도한다.
    let command: string;
    try { command = await options.executable(); } catch { return { outcome: "failed", failureCode: "cli_unavailable" }; }
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
    if (result.failureCode === "cli_unavailable") return "cli_unavailable";
    // CLI 의 보호 거부 — 네트워크 문제가 아니므로 원인을 그대로 알린다(CLI 2.1.310 실측 문구·코드).
    if (/reserved for official anthropic marketplaces/.test(text)) return "reserved_name";
    if (result.failureCode === "declared" || /doesn't match its extraknownmarketplaces entry/.test(text)) {
      const name = /cannot add marketplace "([^"]+)"/i.exec(result.message ?? "")?.[1];
      return name && PRESET_MARKETPLACES.some((preset) => preset.name === name) ? "preset_name" : "name_taken";
    }
    if (/auth|permission denied|could not read username|publickey|host key verification|could not read from remote repository|403|401/.test(text)) return "auth_failed";
    if (/marketplace\.json|manifest/.test(text)) return "no_manifest";
    if (result.failureCode === "not_found" || /not found|404|does not exist/.test(text)) return "not_found";
    return "fetch_failed";
  };

  const known = (): Record<string, { readonly installLocation?: string }> => {
    const raw = readJson(path.join(home, "plugins", "known_marketplaces.json"));
    return isRecord(raw) ? raw as Record<string, { readonly installLocation?: string }> : {};
  };
  const installed = (): Record<string, readonly { readonly installPath?: string; readonly version?: string; readonly gitCommitSha?: string }[]> => {
    const raw = readJson(path.join(home, "plugins", "installed_plugins.json"));
    return isRecord(raw) && isRecord(raw.plugins) ? raw.plugins as Record<string, readonly { readonly installPath?: string; readonly version?: string; readonly gitCommitSha?: string }[]> : {};
  };
  /** 업데이트 전 설치 기록 스냅샷 — 신뢰 없는 새 버전을 되돌릴 때 그대로 쓴다. */
  const snapshotInstalled = (id: string): unknown[] | undefined => {
    const raw = readJson(path.join(home, "plugins", "installed_plugins.json"));
    if (!isRecord(raw) || !isRecord(raw.plugins) || !Array.isArray(raw.plugins[id])) return undefined;
    return JSON.parse(JSON.stringify(raw.plugins[id])) as unknown[];
  };
  /** 설치 기록을 스냅샷으로 되돌린다 — 캐시에 남은 이전 버전 폴더가 다시 설치본이 된다. */
  const restoreInstalled = (id: string, snapshot: unknown[] | undefined): void => {
    const file = path.join(home, "plugins", "installed_plugins.json");
    const raw = readJson(file);
    if (!isRecord(raw) || !isRecord(raw.plugins)) return;
    const plugins = { ...(raw.plugins as Record<string, unknown>) };
    if (snapshot === undefined) delete plugins[id];
    else plugins[id] = snapshot;
    let mode: number | undefined;
    try { mode = fs.statSync(file).mode; } catch { mode = undefined; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    if (mode === undefined) fs.writeFileSync(tmp, `${JSON.stringify({ ...raw, plugins }, null, 2)}\n`);
    else fs.writeFileSync(tmp, `${JSON.stringify({ ...raw, plugins }, null, 2)}\n`, { mode });
    fs.renameSync(tmp, file);
  };

  /** marketplace.json 원문과, 받은 것이 디렉터리(git 출처)면 그 루트. url 출처는 파일 하나라 루트가 없다. */
  const documentOf = (name: string): { readonly root: string | null; readonly raw: Record<string, unknown> } | null => {
    const location = known()[name]?.installLocation;
    if (!location) return null;
    let file = location;
    let root: string | null = null;
    try { if (fs.statSync(location).isDirectory()) { root = location; file = path.join(location, ".claude-plugin", "marketplace.json"); } } catch { return null; }
    const raw = readJson(file);
    return isRecord(raw) ? { root, raw } : null;
  };
  /** marketplace.json 의 플러그인 항목. 위치가 파일(url 출처)이든 디렉터리든 읽는다. */
  const entriesOf = (name: string): readonly MarketplaceEntry[] => {
    const raw = documentOf(name)?.raw;
    if (!raw || !Array.isArray(raw.plugins)) return [];
    return raw.plugins.filter((entry): entry is MarketplaceEntry => isRecord(entry) && typeof entry.name === "string" && segment.test(entry.name));
  };
  /**
   * 받기 전에도 읽을 수 있는 플러그인 폴더 — 마켓플레이스 저장소 안의 상대 경로 출처뿐이다(Claude Code 도 받기 전에는 이것만 읽는다).
   * 외부 출처(github·git-subdir 등)는 받은 뒤 설치본에서만 읽힌다.
   */
  type MarketplaceDocument = ReturnType<typeof documentOf>;
  const bundledDirOf = (document: MarketplaceDocument, entry: MarketplaceEntry): string | null => {
    if (!document?.root || typeof entry.source !== "string") return null;
    const pluginRoot = isRecord(document.raw.metadata) && typeof document.raw.metadata.pluginRoot === "string" ? document.raw.metadata.pluginRoot : null;
    const relative = entry.source.startsWith("./") || entry.source === "." || !pluginRoot || entry.source.includes("/") ? entry.source : path.posix.join(pluginRoot, entry.source);
    const dir = inside(document.root, relative);
    return dir && fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
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
    const readInside = (file: string | null) => file && staysInside(dir, file) ? readJson(file) : undefined;
    const declared = manifestOf(dir).mcpServers;
    for (const item of Array.isArray(declared) ? declared : [declared]) {
      if (typeof item === "string") absorb(readInside(inside(dir, item)));
      else absorb(item);
    }
    absorb(readInside(path.join(dir, ".mcp.json")));
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
    const readInside = (file: string | null) => file && staysInside(dir, file) ? readJson(file) : undefined;
    const declared = manifestOf(dir).hooks;
    for (const item of Array.isArray(declared) ? declared : [declared]) {
      if (typeof item === "string") absorb(readInside(inside(dir, item)));
      else absorb(item);
    }
    absorb(readInside(path.join(dir, "hooks", "hooks.json")));
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
    // 사람의 신뢰가 필요한 것은 이 컴퓨터에서 실행되는 것뿐이다 — 훅 명령과 stdio MCP. 원격(http·sse) MCP 는 실행이 아니라 접속이다.
    const runs = [
      ...hooks.map(([event, command]) => ({ kind: "hook" as const, label: event!, command: command! })),
      ...Object.entries(mcp).flatMap(([name, config]) => typeof config.command === "string" && config.command.trim()
        ? [{ kind: "mcp" as const, label: name, command: [config.command, ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(" ") }]
        : []),
    ];
    const version = typeof manifest.version === "string" ? manifest.version : installed()[id]?.[0]?.version;
    return { components, ...(runs.length ? { runs } : {}), ...(version ? { version } : {}) };
  };

  /**
   * 카드에 보일 표시 필드. 항목 값이 먼저이고, 없으면 읽을 수 있는 폴더의 plugin.json 값이다. 아이콘은 plugin.json 에만 있다
   * (marketplace 항목은 디렉터리 목록 필드를 받지 않는다).
   */
  const display = (entry: MarketplaceEntry, dir: string | null, descriptionMax = MAX_PLUGIN_CARD_DESCRIPTION): Pick<PluginCatalogEntry, "description" | "displayName" | "category" | "author" | "homepage" | "license" | "repository" | "keywords" | "icon"> => {
    const manifest = dir ? manifestOf(dir) : {};
    const description = text(entry.description, descriptionMax) ?? text(manifest.description, descriptionMax);
    const displayName = text(entry.displayName, 120) ?? text(manifest.displayName, 120);
    const category = text(entry.category, 60) ?? text(manifest.category, 60);
    const author = personName(entry.author) ?? personName(manifest.author);
    const homepage = webAddress(entry.homepage) ?? webAddress(manifest.homepage);
    const license = licenseOf(entry.license) ?? licenseOf(manifest.license);
    const repository = repositoryOf(entry.repository) ?? repositoryOf(manifest.repository);
    const keywords = keywordsOf(entry.keywords) ?? keywordsOf(manifest.keywords);
    const icon = dir !== null && iconFileOf(dir, manifest.icon) !== null;
    return {
      ...(description ? { description } : {}), ...(displayName ? { displayName } : {}), ...(category ? { category } : {}),
      ...(author ? { author } : {}), ...(homepage ? { homepage } : {}), ...(license ? { license } : {}),
      ...(repository ? { repository } : {}), ...(keywords ? { keywords } : {}), ...(icon ? { icon: true as const } : {}),
    };
  };
  /** 구성 이름. 플러그인 코드는 실행하지 않고, 폴더 밖 링크는 이름에도 넣지 않는다. */
  const contentsOf = (dir: string): PluginContents => {
    const manifest = manifestOf(dir);
    const events: string[] = [];
    for (const [event] of hookCommands(dir)) {
      if (!event || events.includes(event) || events.length >= MAX_PLUGIN_PARTS) continue;
      events.push(event.slice(0, 120));
    }
    return {
      skills: partNames(dir, declaredDirs(dir, manifest.skills, "skills"), (_name, full) => fs.existsSync(path.join(full, "SKILL.md"))),
      commands: partNames(dir, declaredDirs(dir, manifest.commands, "commands"), (name) => name.endsWith(".md")),
      agents: partNames(dir, declaredDirs(dir, manifest.agents, "agents"), (name) => name.endsWith(".md")),
      hooks: events,
      mcp: Object.keys(mcpDeclarations(dir)).slice(0, MAX_PLUGIN_PARTS),
    };
  };
  /** 표시에 쓸 폴더 — 받은 것은 설치본, 아니면 마켓플레이스 안의 상대 경로 폴더. */
  const displayDirOf = (id: string, document: MarketplaceDocument, entry: MarketplaceEntry, installs: ReturnType<typeof installed>): string | null =>
    (installs[id] ? loadDirOf(id) : null) ?? bundledDirOf(document, entry);

  const view = (row: RegistryMarketplace): MarketplaceView => {
    const raw = documentOf(row.name)?.raw;
    const description = raw ? text(raw.description, 300) ?? (isRecord(raw.metadata) ? text(raw.metadata.description, 300) : undefined) : undefined;
    const owner = raw ? personName(raw.owner) : undefined;
    return {
      name: row.name, kind: row.kind, locator: row.locator, ...(row.ref ? { ref: row.ref } : {}),
      preset: row.preset, enabled: row.enabled, status: row.status, ...(row.error ? { error: row.error } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}), pluginCount: entriesOf(row.name).length,
      ...(description ? { description } : {}), ...(owner ? { owner } : {}),
    };
  };
  /** `v1.5.5` 같은 표기는 앞의 `v` 를 벗기고 버전으로 받는다. `main` 같은 ref 는 버전이 아니다. */
  const versionShapedRef = (ref: unknown): string | undefined => {
    if (typeof ref !== "string") return undefined;
    const bare = /^[vV](?=\d)/.test(ref) ? ref.slice(1) : ref;
    return /^\d+\.\d+/.test(bare) ? bare : undefined;
  };
  /**
   * 설치본 대비 마켓 쪽 새 버전 후보 — 파일만 읽고 CLI·네트워크를 부르지 않는다.
   * - 상대 경로 출처(마켓 저장소 안 폴더): 그 폴더 plugin.json version → 마켓 항목 version. 둘 다 없으면 비움.
   * - 외부 출처(url·git-subdir·github): 항목 source.sha 가 설치본 gitCommitSha 와 다르면 항목 version → 버전 모양의
   *   source.ref → sha 앞 12자. 새 버전의 실행 명령은 미리 읽을 수 없어 runs 는 싣지 않는다.
   * - 설치본과 같은 표시값이어도 sha 가 다르면 싣는다(버전을 올리지 않은 채 내용만 바뀐 경우). 그 밖이나 읽을 수 없으면 비움.
   */
  const latestOf = (
    id: string,
    entry: MarketplaceEntry,
    document: MarketplaceDocument,
    installedVersion: string | undefined,
    installs: ReturnType<typeof installed>,
    trusted: Readonly<Record<string, string>>,
  ): Pick<PluginCatalogEntry, "latestVersion" | "latestRuns"> => {
    if (!installs[id] || !installedVersion) return {};
    const bundled = bundledDirOf(document, entry);
    if (bundled) {
      const candidate = text(manifestOf(bundled).version, 128) ?? text(entry.version, 128);
      if (!candidate || candidate === installedVersion) return {};
      const runs = describe(id, bundled).runs;
      return { latestVersion: candidate, ...(runs?.length && trusted[id] !== candidate ? { latestRuns: runs } : {}) };
    }
    const source = isRecord(entry.source) ? entry.source : null;
    const sha = source && typeof source.sha === "string" && source.sha ? source.sha : undefined;
    const installedSha = installs[id]?.[0]?.gitCommitSha;
    if (!source || !sha || !installedSha || sha === installedSha) return {};
    const display = text(entry.version, 128) ?? versionShapedRef(source.ref) ?? sha.slice(0, 12);
    if (!display) return {};
    return { latestVersion: display };
  };
  const catalog = (): PluginCatalogView => {
    const registry = readRegistry();
    const installs = installed();
    const plugins: PluginCatalogEntry[] = [];
    for (const row of registry.marketplaces) {
      if (!row.enabled) continue;
      const document = documentOf(row.name);
      for (const entry of entriesOf(row.name)) {
        const id = `${entry.name}@${row.name}`;
        const dir = displayDirOf(id, document, entry, installs);
        const described = dir && installs[id] ? describe(id, dir) : null;
        plugins.push({ id, name: entry.name, marketplace: row.name, ...display(entry, dir),
          ...(typeof entry.version === "string" ? { version: entry.version } : {}),
          ...(described ? { ...described, ...latestOf(id, entry, document, described.version, installs, registry.trusted) } : {}) });
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
    if (!preset && isPresetName) {
      // CLI 는 같은 이름의 마켓플레이스 출처를 바꿔 쓴다 — 기본 제공의 출처를 되돌려 놓고 거절한다.
      const original = PRESET_MARKETPLACES.find((item) => item.name === name)!;
      await runCli(["marketplace", "remove", name]).catch(() => undefined);
      await runCli(["marketplace", "add", original.repo]).catch(() => undefined);
      throw new CommodoreStoreError("preset_name");
    }
    if (expected && expected !== name) { patchMarketplace(expected, { status: "failed", error: "no_manifest" }); throw new CommodoreStoreError("no_manifest"); }
    const row: RegistryMarketplace = { name, kind: source.kind, locator: source.locator, ...(source.ref ? { ref: source.ref } : {}), preset, enabled: true, status: "ready", updatedAt: now() };
    const registry = update((current) => {
      const existing = current.marketplaces.find((item) => item.name === name);
      const merged = existing ? { ...row, enabled: existing.enabled } : row;
      return { ...current, marketplaces: existing ? current.marketplaces.map((item) => item.name === name ? merged : item) : [...current.marketplaces, merged] };
    });
    return view(registry.marketplaces.find((item) => item.name === name)!);
  };

  /** 켜진 기본 제공을 등록하고, 하루 지난 것은 새로 받는다. 꺼진 곳은 배경에서 받지 않는다 — 켜거나 「갱신」할 때 받는다. 실패는 그 행의 상태로 남는다. */
  const ensurePresets = (): Promise<void> => ensuring ??= serial(async () => {
    try {
      for (const preset of PRESET_MARKETPLACES) {
        const row = readRegistry().marketplaces.find((item) => item.name === preset.name);
        // 꺼진 곳은 받지 않으므로 받는 중으로 남은 표시(켰다가 바로 끈 경우 등)를 걷는다 — 남겨 두면 화면이 끝없이 다시 읽는다.
        if (row && !row.enabled) { if (row.status === "syncing") patchMarketplace(preset.name, { status: "ready" }); continue; }
        if (row && row.status === "ready" && row.updatedAt && now() - row.updatedAt < PRESET_REFRESH_MS && known()[preset.name]) continue;
        if (row && row.status === "failed" && row.attemptedAt && now() - row.attemptedAt < PRESET_RETRY_MS) continue;
        if (!row) update((registry) => ({ ...registry, marketplaces: [...registry.marketplaces, { name: preset.name, kind: "github", locator: preset.repo, preset: true, enabled: preset.enabled, status: preset.enabled ? "syncing" : "ready", ...(preset.enabled ? { attemptedAt: now() } : {}) }] }));
        else patchMarketplace(preset.name, { status: "syncing", attemptedAt: now() });
        if (known()[preset.name]) {
          const result = await runCli(["marketplace", "update", preset.name]);
          // CLI 가 없으면 실패로 남겨 재시도 간격(PRESET_RETRY_MS)을 따르게 한다 — 받아 둔 이전 목록은 실패여도 그대로 보인다.
          const unavailable = result.failureCode === "cli_unavailable";
          patchMarketplace(preset.name, result.outcome === "ok" ? { status: "ready", updatedAt: now() } : { status: known()[preset.name] && !unavailable ? "ready" : "failed", ...(result.outcome === "ok" ? {} : { error: errorCode(result) }) }, result.outcome === "ok");
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
      if (result.outcome !== "ok") throw new CommodoreStoreError(result.failureCode === "cli_unavailable" ? "cli_unavailable" : "install_failed");
    }
    const dir = loadDirOf(id);
    if (!dir) throw new CommodoreStoreError("install_failed");
    return { id, name: plugin, marketplace, ...display(entry, dir), ...describe(id, dir) };
  });

  /**
   * 상세. 받은 설치본이나 마켓 안 상대 경로 폴더가 있으면 그대로 읽고, 없으면 inspect 와 같이 Fleet 홈에 받은 뒤 읽는다.
   * README·구성 이름은 그 폴더 안에서만. 플러그인 코드는 실행하지 않는다.
   */
  const detail = (id: string): Promise<PluginDetail> => serial(async () => {
    const { plugin, marketplace } = splitPluginId(id);
    const row = requireRow(marketplace);
    if (!row.enabled) throw new CommodoreStoreError("disabled");
    const entry = entryOf(id);
    if (!entry) throw new CommodoreStoreError("plugin_not_found");
    let dir = displayDirOf(id, documentOf(marketplace), entry, installed());
    if (!dir) {
      const result = await runCli(["install", id]);
      if (result.outcome !== "ok") throw new CommodoreStoreError(result.failureCode === "cli_unavailable" ? "cli_unavailable" : "install_failed");
      dir = loadDirOf(id);
      if (!dir) throw new CommodoreStoreError("install_failed");
    }
    const described = describe(id, dir);
    const version = described.version ?? (typeof entry.version === "string" ? entry.version : undefined);
    const readme = readmeOf(dir, [manifestOf(dir).readme, entry.readme]);
    return {
      id, name: plugin, marketplace, ...display(entry, dir, MAX_PLUGIN_DETAIL_DESCRIPTION), ...described,
      ...(version ? { version } : {}), contents: contentsOf(dir),
      ...(readme ? { readme: readme.text, ...(readme.truncated ? { readmeTruncated: true as const } : {}) } : {}),
    };
  });

  /** 아이콘 그림 — 등록된 마켓플레이스의 항목이고, 읽을 수 있는 폴더 안의 검사를 지난 그림일 때만. 플러그인 코드는 실행하지 않는다. */
  const icon = (id: string): { readonly bytes: Buffer; readonly mime: string } | null => {
    const { marketplace } = splitPluginId(id);
    if (!readRegistry().marketplaces.some((row) => row.name === marketplace)) return null;
    const entry = entryOf(id);
    if (!entry) return null;
    const dir = displayDirOf(id, documentOf(marketplace), entry, installed());
    if (!dir) return null;
    const found = iconFileOf(dir, manifestOf(dir).icon);
    if (!found) return null;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(found.file); } catch { return null; }
    return bytes.byteLength <= MAX_PLUGIN_ICON_BYTES && looksLike(found.mime, bytes) ? { bytes, mime: found.mime } : null;
  };

  /**
   * 플러그인 키 — `<root>/keys.json`(0600). 화면·로그·세션 기록에는 싣지 않고, 세션을 열 때 자식 환경에만 얹는다.
   * 사령관마다가 아니라 플러그인마다 하나다 — OAuth 토큰도 Claude Code 보안 저장소에 서버마다 하나다.
   */
  const keysFile = path.join(options.root, KEYS_FILE);
  const readKeys = (): Readonly<Record<string, Readonly<Record<string, string>>>> => {
    const raw = readJson(keysFile);
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.keys)) return {};
    const keys: Record<string, Record<string, string>> = {};
    for (const [id, table] of Object.entries(raw.keys)) {
      if (!pluginIdSchema.safeParse(id).success || !isRecord(table)) continue;
      const own = Object.fromEntries(Object.entries(table).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry[0]) && !RESERVED_KEY.test(entry[0])));
      if (Object.keys(own).length) keys[id] = own;
    }
    return keys;
  };
  const writeKeys = (keys: Readonly<Record<string, Readonly<Record<string, string>>>>): void => {
    fs.mkdirSync(options.root, { recursive: true });
    const tmp = `${keysFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, keysFile);
  };

  /**
   * 세션에 실을 수 있는 플러그인과 그 MCP 서버. 서버 이름은 Claude Code 가 `--plugin-dir` 플러그인 서버에 붙이는
   * `plugin:<plugin.json name>:<서버>`(CLI 2.1.312 판독)다. 값은 `${CLAUDE_PLUGIN_ROOT}`만 펼친 선언 그대로다.
   */
  const loadable = (ids: readonly string[]) => {
    const found: { readonly id: string; readonly dir: string; readonly servers: readonly { readonly server: string; readonly name: string; readonly config: ClaudeGatewayExternalMcpServer }[] }[] = [];
    for (const id of ids) {
      let dir: string | null = null;
      try { dir = loadDirOf(id); } catch (error) { console.warn(`[commodore] plugin ${id} unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      if (!dir) continue;
      const manifestName = manifestOf(dir).name;
      const pluginName = typeof manifestName === "string" && segment.test(manifestName) ? manifestName : splitPluginId(id).plugin;
      const servers: { server: string; name: string; config: ClaudeGatewayExternalMcpServer }[] = [];
      for (const [server, config] of Object.entries(mcpDeclarations(dir))) {
        const name = `plugin:${pluginName}:${server}`;
        const type = config.type === "http" || config.type === "sse" ? config.type : typeof config.url === "string" && config.command === undefined ? "http" : "stdio";
        if (type === "stdio" && typeof config.command === "string") {
          servers.push({ server, name, config: { type: "stdio", command: config.command, ...(Array.isArray(config.args) ? { args: config.args.map(String) } : {}), ...(isRecord(config.env) ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, String(value)])) } : {}) } });
        } else if (type !== "stdio" && typeof config.url === "string" && /^https?:\/\/\S+$/i.test(config.url)) {
          servers.push({ server, name, config: { type, url: config.url, ...(isRecord(config.headers) ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value)])) } : {}) } });
        }
      }
      found.push({ id, dir, servers });
    }
    return found;
  };

  const resolve = (ids: readonly string[]): readonly ResolvedPlugin[] => {
    const stored = readKeys();
    return loadable(ids).map(({ id, dir, servers }) => {
      const env: Record<string, string> = {};
      for (const { config } of servers) for (const key of keyNamesOf(config)) { const value = stored[id]?.[key]; if (value) env[key] = value; }
      return { id, path: dir, mcpServers: Object.fromEntries(servers.map(({ name, config }) => [name, config])), env };
    });
  };

  return {
    /**
     * 목록을 처음 읽을 때 없는 기본 제공 행을 세운다. 켜진 곳만 받는 중으로 두고 배경에서 등록·갱신한다.
     * Console 기동에서 하지 않는 이유: 화면을 열지 않는 Console(테스트·원격 전용 등)까지 네트워크로 저장소를 받게 되기 때문이다.
     */
    catalog(): PluginCatalogView {
      settlePresetActivation();
      const missing = PRESET_MARKETPLACES.filter((preset) => !readRegistry().marketplaces.some((row) => row.name === preset.name));
      if (missing.length) update((registry) => ({ ...registry, marketplaces: [...registry.marketplaces, ...missing.map((preset): RegistryMarketplace => ({ name: preset.name, kind: "github", locator: preset.repo, preset: true, enabled: preset.enabled, status: preset.enabled ? "syncing" : "ready" }))] }));
      void ensurePresets();
      return catalog();
    },
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
          patchMarketplace(target, { status: "syncing", attemptedAt: now() });
          // 한 번도 받지 못한 기본 제공(예: 오프라인 첫 기동)은 CLI 가 모르므로 갱신이 아니라 추가로 받는다.
          const preset = PRESET_MARKETPLACES.find((item) => item.name === target);
          if (preset && !known()[target]) {
            await fetchMarketplace({ kind: "github", locator: preset.repo, cliSource: preset.repo }, true, target).catch(() => undefined);
            continue;
          }
          const result = await runCli(["marketplace", "update", target]);
          patchMarketplace(target, result.outcome === "ok" ? { status: "ready", updatedAt: now() } : { status: "failed", error: errorCode(result) }, result.outcome === "ok");
        }
      });
      return catalog();
    },
    enable(name: string, enabled: boolean): PluginCatalogView {
      const row = requireRow(name);
      // 아직 받아 두지 않은 마켓을 켜면 받는 중으로 세워 화면이 끝날 때까지 다시 읽게 한다. 이미 받은 곳은 그대로 둔다.
      patchMarketplace(name, { enabled, ...(enabled && !row.enabled && !known()[name] ? { status: "syncing" } : {}) });
      return catalog();
    },
    async remove(name: string): Promise<PluginCatalogView> {
      const row = requireRow(name);
      if (row.preset) throw new CommodoreStoreError("preset_locked");
      await serial(async () => {
        // CLI 가 없으면 지우지 않는다 — 받아 둔 마켓플레이스와 그 플러그인이 Claude 홈에 남은 채 등록부에서만 사라지면 다시 찾을 길이 없다.
        const result = await runCli(["marketplace", "remove", name]);
        if (result.failureCode === "cli_unavailable") throw new CommodoreStoreError("cli_unavailable");
        update((registry) => ({ ...registry, marketplaces: registry.marketplaces.filter((item) => item.name !== name) }));
      });
      return catalog();
    },
    inspect,
    detail,
    icon,
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
     * 플러그인 단위 업데이트 — `claude plugin update <id> --json` 으로 올린다. `-y`·`--accept-command` 는 쓰지 않는다.
     * 같은 플러그인의 동시 요청은 직렬로 줄 세운다. 실패하면 설치본은 그대로다(CLI 가 그렇게 남긴다).
     *
     * 신뢰(기준 6): 새 버전에 실행 명령이 있고 그 버전을 신뢰한 적이 없으면, 사람이 확인하기 전에 새 버전이 어떤 세션에도
     * 실리지 않게 거절한다(`trust_required`, details `{ version, runs }`). 상대 경로 출처는 업데이트 전에 번들 폴더로
     * 판단하므로 CLI 를 부르기 전에 거절한다. 미리 읽을 수 없으면(외부 출처·버전 없는 상대 플러그인) 업데이트 뒤 새
     * 설치본으로 판단하고, 신뢰가 없으면 설치 기록을 이전 버전(캐시에 남아 있음)으로 되돌린 뒤 같은 거절을 낸다.
     * `trusted` 로 다시 오면 `trusted[id] = 새 버전` 을 기록하고 진행한다.
     */
    async updatePlugin(id: string, trustedFlag: boolean): Promise<PluginUpdateResult> {
      return await serial(async () => {
        const { marketplace } = splitPluginId(id);
        const row = requireRow(marketplace);
        if (!row.enabled) throw new CommodoreStoreError("disabled");
        const entry = entryOf(id);
        if (!entry) throw new CommodoreStoreError("plugin_not_found");
        const installs = installed();
        const before = installs[id]?.[0];
        const beforeDir = loadDirOf(id);
        const beforeVersion = (beforeDir ? describe(id, beforeDir).version : undefined) ?? before?.version;
        // 상대 출처는 업데이트 전에 번들 폴더로 새 버전·실행 명령을 안다 — 신뢰 없으면 CLI 를 부르기 전에 거절한다.
        const bundled = bundledDirOf(documentOf(row.name), entry);
        const candidate = bundled ? text(manifestOf(bundled).version, 128) ?? text(entry.version, 128) : undefined;
        const preRuns = bundled ? describe(id, bundled).runs ?? [] : [];
        if (bundled && candidate && beforeVersion && candidate !== beforeVersion && preRuns.length > 0 && readRegistry().trusted[id] !== candidate) {
          if (!trustedFlag) throw new CommodoreStoreError("trust_required", undefined, { version: candidate, runs: preRuns });
          update((registry) => ({ ...registry, trusted: { ...registry.trusted, [id]: candidate } }));
        }
        const snapshot = snapshotInstalled(id);
        const result = await runCli(["update", id]);
        if (result.outcome !== "ok") {
          // CLI 가 명령 확인을 요구하면 신뢰 확인으로 돌려준다.
          if (result.failureCode === "trust_required" || result.failureCode === "confirmation_required" || result.failureCode === "accept_command" || result.failureCode === "command_confirmation" || /--accept-command/i.test(result.message ?? "")) {
            const version = candidate ?? (typeof result.newVersion === "string" && result.newVersion ? result.newVersion : undefined) ?? beforeVersion;
            throw new CommodoreStoreError("trust_required", undefined, { ...(version ? { version } : {}), runs: preRuns });
          }
          if (result.failureCode === "source_missing") throw new CommodoreStoreError("source_missing");
          if (result.failureCode === "not_found") throw new CommodoreStoreError("not_found");
          if (result.failureCode === "cli_unavailable") throw new CommodoreStoreError("cli_unavailable");
          throw new CommodoreStoreError("update_failed");
        }
        const oldVersion = typeof result.oldVersion === "string" && result.oldVersion ? result.oldVersion : undefined;
        const newVersion = typeof result.newVersion === "string" && result.newVersion ? result.newVersion : undefined;
        if (!oldVersion || !newVersion) throw new CommodoreStoreError("update_failed");
        if (result.updateOutcome === "up_to_date" || oldVersion === newVersion) {
          return { outcome: "up_to_date" as const, oldVersion, newVersion, view: catalog() };
        }
        // 버전이 바뀌었다 — 미리 읽을 수 없었던 경우는 새 설치본으로 신뢰를 판단한다.
        const afterDir = loadDirOf(id);
        if (!afterDir) throw new CommodoreStoreError("update_failed");
        const after = describe(id, afterDir);
        const key = after.version ?? newVersion;
        const runs = after.runs ?? [];
        if (runs.length > 0 && readRegistry().trusted[id] !== key) {
          if (!trustedFlag) {
            restoreInstalled(id, snapshot);
            throw new CommodoreStoreError("trust_required", undefined, { version: key, runs });
          }
          update((registry) => ({ ...registry, trusted: { ...registry.trusted, [id]: key } }));
        }
        return { outcome: "updated" as const, oldVersion, newVersion, view: catalog() };
      });
    },
    /**
     * 세션을 여는 순간 고른 플러그인을 경로와 MCP 선언으로 푼다. 받지 않았거나 사라진 것은 건너뛴다 — 세션을 막지 않는다.
     * 마켓플레이스를 꺼도 이미 설치한 것은 실린다(끄기는 새 설치만 막는다).
     */
    resolve,
    /** 고른 플러그인의 서버 중 사람의 인증이 필요할 수 있는 것 — OAuth 원격 서버와 `${VAR}` 키를 받는 서버. */
    authServers(ids: readonly string[]): readonly PluginAuthServer[] {
      const stored = readKeys();
      const base = options.env?.() ?? process.env;
      const found: PluginAuthServer[] = [];
      for (const { id, servers } of loadable(ids)) {
        for (const { server, name, config } of servers) {
          const keys = keyNamesOf(config);
          const missing = keys.filter((key) => !stored[id]?.[key] && !base[key]);
          const saved = keys.filter((key) => Boolean(stored[id]?.[key]));
          const unsupported = placeholdersOf(config).filter((key) => RESERVED_KEY.test(key) && !base[key]);
          if (keys.length || unsupported.length) { found.push({ pluginId: id, server, name, config, mode: "key", keys, missing, saved, unsupported }); continue; }
          // 헤더에 고정 자격이 있으면 Claude Code 는 OAuth 를 시도하지 않는다. stdio 는 로그인할 대상이 아니다.
          if (config.type === "stdio" || Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) continue;
          found.push({ pluginId: id, server, name, config, mode: "oauth", keys: [], missing: [], saved: [], unsupported: [] });
        }
      }
      return found;
    },
    /**
     * 그 플러그인들의 MCP 선언이 가리키는 키 값 — 사령관·목표 세션과 인증 확인 자식의 환경에 얹는다. 선언이 가리키지 않는
     * 이름과 실행 환경 이름은 싣지 않는다. 같은 이름을 두 플러그인이 쓰면 먼저 고른 쪽이다.
     */
    pluginEnv(ids: readonly string[]): Readonly<Record<string, string>> {
      return mergePluginEnv(resolve(ids));
    },
    /** 플러그인 키를 넣거나(`value`) 지운다(`null`). 그 플러그인 MCP 선언이 가리키는 이름만 받는다. 값은 돌려주지 않는다. */
    setKey(pluginId: string, key: string, value: string | null): void {
      const plugin = loadable([pluginId])[0];
      if (!plugin || !plugin.servers.some(({ config }) => keyNamesOf(config).includes(key))) throw new CommodoreStoreError("invalid_request");
      if (value !== null && (!value.trim() || Buffer.byteLength(value, "utf8") > MAX_PLUGIN_KEY_BYTES || /[\0\r\n]/.test(value))) throw new CommodoreStoreError("invalid_request");
      const keys = { ...readKeys() };
      const own = { ...keys[pluginId] };
      if (value === null) delete own[key]; else own[key] = value.trim();
      if (Object.keys(own).length) keys[pluginId] = own; else delete keys[pluginId];
      writeKeys(keys);
    },
  };
}

/** 여러 플러그인의 키를 한 환경으로. 같은 이름은 먼저 고른 플러그인 쪽이다. */
export function mergePluginEnv(plugins: readonly Pick<ResolvedPlugin, "env">[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const plugin of plugins) for (const [key, value] of Object.entries(plugin.env)) if (!(key in env)) env[key] = value;
  return env;
}

/** 선언의 모든 문자열 값에서 기본값 없는 `${VAR}` 이름. */
function placeholdersOf(config: ClaudeGatewayExternalMcpServer): string[] {
  const values = config.type === "stdio"
    ? [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})]
    : [config.url, ...Object.values(config.headers ?? {})];
  const names: string[] = [];
  for (const value of values) for (const match of value.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (match[2] === undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 사람이 Console 에 넣을 수 있는 키 — 실행 환경 이름은 키가 아니다. */
function keyNamesOf(config: ClaudeGatewayExternalMcpServer): string[] {
  return placeholdersOf(config).filter((name) => !RESERVED_KEY.test(name));
}
export type CommodorePlugins = ReturnType<typeof createCommodorePlugins>;
