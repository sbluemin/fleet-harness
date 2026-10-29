import { z } from "zod";

/**
 * 사령관 플러그인 — Console 이 소유하는 마켓플레이스 등록부와 그 카탈로그, 사령관마다 고른 설치 목록의 브라우저 계약.
 *
 * 마켓플레이스·플러그인 파일은 Console 데이터의 Fleet 전용 Claude 홈 하나에 받아 둔다(사용자 `~/.claude` 는 읽지도 쓰지도
 * 않는다). 사령관은 그중 고른 것만 `state.json` 의 `plugins` 로 기억하고, 그 사령관 세션과 그 사령관이 소유한 목표의
 * 지휘관·구성원 세션이 다음 턴(새 세션)부터 로컬 경로로 싣는다. 이 DTO 에는 파일 경로가 실리지 않는다 — 위치는 사람이
 * 입력한 저장소·URL 표기(`locator`)뿐이다.
 */

/**
 * Anthropic 이 운영하는 기본 제공 마켓플레이스 — 처음부터 등록되고 지울 수 없다(끌 수는 있다). 이름은 marketplace.json 의 name.
 * `enabled` 는 등록부가 아직 없을 때의 처음 켜짐이다. 이미 등록된 행은 이 값으로 매번 덮지 않는다.
 */
export const PRESET_MARKETPLACES = Object.freeze([
  { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official", enabled: true },
  { name: "claude-community", repo: "anthropics/claude-plugins-community", enabled: true },
  { name: "knowledge-work-plugins", repo: "anthropics/knowledge-work-plugins", enabled: false },
  { name: "claude-for-financial-services", repo: "anthropics/financial-services", enabled: false },
  { name: "claude-for-legal", repo: "anthropics/claude-for-legal", enabled: false },
  { name: "life-sciences", repo: "anthropics/life-sciences", enabled: false },
] as const);

/** 사령관 하나가 설치할 수 있는 플러그인 수. */
export const MAX_COMMODORE_PLUGINS = 64;
/** 커스텀 마켓플레이스 수(기본 제공 제외). */
export const MAX_CUSTOM_MARKETPLACES = 32;
export const MAX_MARKETPLACE_SOURCE = 512;
export const MAX_MARKETPLACE_REF = 128;

const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
export const marketplaceNameSchema = z.string().regex(segment);
/** `plugin@marketplace` — Claude Code 의 플러그인 식별자와 같은 모양이다. */
export const pluginIdSchema = z.string().max(256).refine((value) => {
  const at = value.lastIndexOf("@");
  return at > 0 && segment.test(value.slice(0, at)) && segment.test(value.slice(at + 1));
});
export const commodorePluginsSchema = z.array(pluginIdSchema).max(MAX_COMMODORE_PLUGINS);

export function splitPluginId(id: string): { readonly plugin: string; readonly marketplace: string } {
  const at = id.lastIndexOf("@");
  return { plugin: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/** 사람이 넣은 출처를 서버가 알아본 결과. git 은 https·ssh 주소, url 은 marketplace.json 주소다. */
export type MarketplaceSourceKind = "github" | "git" | "url";

export interface MarketplaceView {
  /** marketplace.json 의 name — `plugin@marketplace` 의 오른쪽. */
  readonly name: string;
  readonly kind: MarketplaceSourceKind;
  /** 사람이 읽는 출처 표기: `owner/repo`, git 주소, marketplace.json URL. 파일 경로가 아니다. */
  readonly locator: string;
  readonly ref?: string;
  readonly preset: boolean;
  /** 끄면 카탈로그에서 숨고 새 설치가 막힌다. 이미 설치한 사령관의 플러그인은 남는다. */
  readonly enabled: boolean;
  /** ready: 카탈로그를 읽었다. syncing: 받는 중. failed: 마지막 받기가 실패했다(이전 카탈로그가 있으면 그대로 보인다). */
  readonly status: "ready" | "syncing" | "failed";
  readonly error?: MarketplaceErrorCode;
  readonly updatedAt?: number;
  readonly pluginCount: number;
  /** marketplace.json 의 `description`(또는 `metadata.description`) — 카드 설명 한 줄. */
  readonly description?: string;
  /** marketplace.json 의 `owner.name` — 직접 추가한 마켓플레이스 카드의 「만든 이」. 마켓플레이스에는 아이콘 필드가 없다. */
  readonly owner?: string;
}

/** 플러그인이 싣는 구성 요소 수. 아직 받지 않아 모르면 카탈로그 항목의 `components` 가 없다. */
export interface PluginComponents {
  readonly skills: number;
  readonly agents: number;
  readonly commands: number;
  readonly hooks: number;
  readonly mcp: number;
}

/** 카드에 실리는 설명 상한. 상세는 이보다 긴 `MAX_PLUGIN_DETAIL_DESCRIPTION` 까지 준다. */
export const MAX_PLUGIN_CARD_DESCRIPTION = 600;
/** 상세 설명 상한. 목록 응답에는 카드 상한만 실린다. */
export const MAX_PLUGIN_DETAIL_DESCRIPTION = 8_000;
/** 상세 README 원문 상한(바이트). 넘치면 앞부분만 싣고 `readmeTruncated` 를 세운다. */
export const MAX_PLUGIN_README_BYTES = 64 * 1024;
export const MAX_PLUGIN_KEYWORDS = 16;
/** 상세가 나열하는 구성 이름 상한. 이름은 폴더·선언에서만 읽고, 파일 경로는 싣지 않는다. */
export const MAX_PLUGIN_PARTS = 64;

/**
 * 상세가 채우는 구성 이름. 수는 `components` 가 담당한다.
 * 스킬·명령·에이전트는 그 폴더의 이름, 훅은 이벤트 이름, MCP 는 `.mcp.json` 또는 plugin.json `mcpServers` 의 키다.
 */
export interface PluginContents {
  readonly skills: readonly string[];
  readonly commands: readonly string[];
  readonly agents: readonly string[];
  readonly hooks: readonly string[];
  readonly mcp: readonly string[];
}

export interface PluginCatalogEntry {
  /** `plugin@marketplace`. */
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly description?: string;
  readonly version?: string;
  /**
   * 표시 필드 — 항목 값이 있으면 그것, 없으면 읽을 수 있는 plugin.json 값이다(Claude Code 의 표시 규칙과 같다). plugin.json 은
   * 받은 뒤나 마켓플레이스 안(상대 경로) 플러그인만 읽힌다. `homepage` 는 http(s) 주소일 때만 싣는다.
   */
  readonly displayName?: string;
  readonly category?: string;
  readonly author?: string;
  readonly homepage?: string;
  /** plugin.json 또는 마켓 항목의 `license`. 없으면 싣지 않는다. */
  readonly license?: string;
  /** http(s) 저장소 주소만. 그 외 표기는 싣지 않는다. */
  readonly repository?: string;
  readonly keywords?: readonly string[];
  /** plugin.json `icon` 이 플러그인 폴더 안 이미지를 가리킨다 — 그림은 `pluginIconPath(id)` 로 읽는다. 경로는 싣지 않는다. */
  readonly icon?: true;
  readonly components?: PluginComponents;
  /**
   * 설치하면 사령관 권한으로 실행되는 명령(훅·stdio MCP) — 사람이 신뢰를 확인하는 원문. 받은 뒤에만 안다.
   * 한 줄씩 `훅 <이벤트> · <명령>` 이 아니라 구조로 준다: 화면이 문구를 고른다.
   */
  readonly runs?: readonly { readonly kind: "hook" | "mcp"; readonly label: string; readonly command: string }[];
  /**
   * 설치본과 다른 마켓 쪽 새 버전 — 설치된 플러그인에만 싣고, 설치본과 다를 때만 있다.
   * 없으면 "업데이트 없음 또는 알 수 없음"이다.
   */
  readonly latestVersion?: string;
  /**
   * 새 버전이 실행할 명령 — 미리 읽을 수 있고(마켓 저장소 안 상대 경로 출처) 그 버전의 신뢰 기록이 없을 때만 싣는다.
   * `runs` 와 같은 배열이다.
   */
  readonly latestRuns?: PluginCatalogEntry["runs"];
}

/**
 * `commodore/plugins/detail` 의 플러그인. 카탈로그 필드는 그대로 두고, 설명만 카드보다 길 수 있다.
 * `readme` 는 플러그인 폴더 안 README 의 markdown 원문이다. 경로·바이너리는 싣지 않고, 플러그인 코드는 실행하지 않는다.
 * `contents` 는 읽기에 성공했을 때만 있다 — 실패는 이 객체가 아니라 오류다.
 */
export interface PluginDetail extends PluginCatalogEntry {
  readonly contents: PluginContents;
  readonly readme?: string;
  readonly readmeTruncated?: true;
}

export interface PluginCatalogView {
  readonly marketplaces: readonly MarketplaceView[];
  /** 켜진 마켓플레이스의 플러그인만. 꺼진 마켓플레이스의 항목은 사령관 설치 목록의 이름 해석에만 쓰인다. */
  readonly plugins: readonly PluginCatalogEntry[];
}

export type MarketplaceErrorCode =
  | "invalid_source"
  | "duplicate"
  | "preset_name"
  /** Claude Code 가 Anthropic 공식 마켓플레이스에 예약한 이름 — anthropics GitHub 출처로만 추가할 수 있다. */
  | "reserved_name"
  /** 같은 이름의 마켓플레이스가 이미 다른 출처로 등록돼 있다. */
  | "name_taken"
  | "not_found"
  | "auth_failed"
  | "no_manifest"
  | "fetch_failed"
  | "preset_locked"
  | "limit"
  | "disabled"
  | "plugin_not_found"
  | "install_failed"
  | "update_failed"
  /** 업데이트하려는 플러그인의 출처 폴더가 사라졌다 — 설치본은 그대로 둔다. */
  | "source_missing"
  | "trust_required"
  | "unavailable"
  /** Console 이 Claude Code CLI 를 찾지 못했다 — 받기·설치·제거는 모두 그 CLI 로 한다. */
  | "cli_unavailable";

/**
 * 라우트 — 모두 POST + JSON, Console 동일 origin. 카탈로그 화면은 응답으로 갱신하고, 사령관 설치 목록은 `commodore` 채널의
 * `state` 사건(change `plugins`)으로도 온다.
 *
 * - `commodore/marketplaces/list` {} → PluginCatalogView
 * - `commodore/marketplaces/add` { source, ref? } → { marketplace: MarketplaceView }
 * - `commodore/marketplaces/update` { name? } → PluginCatalogView (name 없으면 전부)
 * - `commodore/marketplaces/enable` { name, enabled } → PluginCatalogView
 * - `commodore/marketplaces/remove` { name } → PluginCatalogView (기본 제공은 preset_locked)
 * - `commodore/plugins/inspect` { pluginId } → { plugin: PluginCatalogEntry } — 받아서 구성 요소·실행 명령을 채운다
 * - `commodore/plugins/detail` { pluginId } → { plugin: PluginDetail } — 카탈로그 필드에 구성 이름·실행 명령·README 를 더한다.
 *   마켓 안 상대 경로 플러그인은 받지 않고 읽고, 그 외에는 inspect 와 같이 Fleet 전용 홈에 받은 뒤 읽는다. 플러그인 코드는 실행하지 않는다.
 * - `commodore/plugins/set` { commodoreId, pluginId, installed, trusted? } → CommodoreStateView
 *   실행 명령이 있는 플러그인을 처음 설치할 때 trusted 가 없으면 trust_required 로 거절한다.
 * - `commodore/plugins/update` { pluginId, trusted?, version? } → { outcome: "updated" | "up_to_date", oldVersion, newVersion, view: PluginCatalogView }
 *   `claude plugin update <id> --json` 으로 올린다. 새 버전에 실행 명령이 있고 그 버전을 신뢰한 적이 없으면
 *   trust_required 로 거절한다(details: { version, runs }). 확인은 trusted 와 그때 본 version 을 함께 보내야 하고,
 *   받은 버전이 다르면 다시 거절한다. -y·--accept-command 는 쓰지 않는다.
 * - GET `commodore/plugins/icon?pluginId=` → 그 플러그인 아이콘 그림(png·jpeg·gif·webp·svg). 카탈로그 항목에 `icon` 이 있을 때만 있다.
 */
export const MAX_PLUGIN_ICON_BYTES = 512 * 1024;
export const pluginIconQuerySchema = z.object({ pluginId: pluginIdSchema }).strict();
/** 브라우저가 `<img>` 로만 읽는 아이콘 주소 — svg 도 문서가 아니라 그림으로 그려 스크립트가 돌지 않는다. */
export function pluginIconPath(pluginId: string): string {
  return `/api/v1/commodore/plugins/icon?${new URLSearchParams({ pluginId })}`;
}
export const marketplaceAddSchema = z.object({
  source: z.string().trim().min(1).max(MAX_MARKETPLACE_SOURCE),
  ref: z.string().trim().min(1).max(MAX_MARKETPLACE_REF).optional(),
}).strict();
export const marketplaceNameRefSchema = z.object({ name: marketplaceNameSchema }).strict();
export const marketplaceEnableSchema = z.object({ name: marketplaceNameSchema, enabled: z.boolean() }).strict();
export const marketplaceUpdateSchema = z.object({ name: marketplaceNameSchema.optional() }).strict();
export const pluginInspectSchema = z.object({ pluginId: pluginIdSchema }).strict();
export const pluginUpdateSchema = z.object({ pluginId: pluginIdSchema, trusted: z.boolean().optional(), version: z.string().min(1).max(128).optional() }).strict();
export const commodorePluginSetSchema = z.object({
  commodoreId: z.string().min(1).max(128),
  pluginId: pluginIdSchema,
  installed: z.boolean(),
  trusted: z.boolean().optional(),
}).strict();

/* ── 플러그인 MCP 인증 ─────────────────────────────────────────────── */

/**
 * 플러그인 MCP 서버 하나의 인증 상태. 토큰·키 값·서버 설정은 싣지 않는다.
 * - oauth: needs-auth(원격 서버가 로그인을 요구), pending(브라우저에서 진행 중), connected, failed, unknown(확인 못 함)
 * - key: key-needed(`${VAR}` 값이 없다), key-set, failed(넣은 키를 서버가 받지 않는다)
 */
export type PluginServerAuthState = "needs-auth" | "pending" | "connected" | "failed" | "unknown" | "key-needed" | "key-set";
/** 실패의 짧은 이유 — 화면이 로케일 한 마디로 옮긴다. */
/** `changed`: 진행 중이던 인증이 그 서버의 설정이나 키가 바뀌어 끝났다. */
export type PluginAuthFailure = "registration" | "timeout" | "unreachable" | "unsupported" | "callback" | "key" | "changed" | "error";

export interface PluginServerAuthView {
  /** 플러그인 선언의 서버 이름(`.mcp.json`의 키). */
  readonly server: string;
  readonly mode: "oauth" | "key";
  readonly state: PluginServerAuthState;
  readonly failure?: PluginAuthFailure;
  /** key 서버가 받는 `${VAR}` 이름. 값은 싣지 않는다. */
  readonly keys?: readonly string[];
  /** key 서버이고 그중 하나라도 Console 에 넣은 값이 있다(지울 것이 있다). */
  readonly saved?: true;
  /** pending 일 때만 — 사람이 브라우저에서 다시 열 인증 주소. */
  readonly authUrl?: string;
  /** pending 이고 콜백을 Console 컴퓨터의 loopback 에서 기다린다 — 다른 기기의 브라우저로는 돌아오지 못한다. */
  readonly local?: true;
}

export interface CommodorePluginAuthView {
  /** 인증과 관련된 서버가 있는 플러그인만. */
  readonly plugins: readonly { readonly pluginId: string; readonly servers: readonly PluginServerAuthView[] }[];
  /** OAuth 상태를 실제로 확인했는가. false 면 Claude Code 를 띄우지 못해 모르는 채다. */
  readonly checked: boolean;
}

const commodoreIdSchema = z.string().min(1).max(128);
const pluginServerSchema = z.string().regex(segment);
/** 플러그인 키 이름 — `${NAME}`의 NAME. */
export const pluginKeyNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const MAX_PLUGIN_KEY_LENGTH = 8_192;
export const pluginAuthStatusSchema = z.object({ commodoreId: commodoreIdSchema, refresh: z.boolean().optional() }).strict();
export const pluginAuthActionSchema = z.object({ commodoreId: commodoreIdSchema, pluginId: pluginIdSchema, server: pluginServerSchema, action: z.enum(["start", "cancel", "clear"]) }).strict();
export const pluginAuthCallbackSchema = z.object({ commodoreId: commodoreIdSchema, pluginId: pluginIdSchema, server: pluginServerSchema, callbackUrl: z.string().min(1).max(4_096) }).strict();
export const pluginKeySetSchema = z.object({ commodoreId: commodoreIdSchema, pluginId: pluginIdSchema, name: pluginKeyNameSchema, value: z.string().max(MAX_PLUGIN_KEY_LENGTH).nullable() }).strict();
