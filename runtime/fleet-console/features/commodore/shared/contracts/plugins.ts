import { z } from "zod";

/**
 * 사령관 플러그인 — Console 이 소유하는 마켓플레이스 등록부와 그 카탈로그, 사령관마다 고른 설치 목록의 브라우저 계약.
 *
 * 마켓플레이스·플러그인 파일은 Console 데이터의 Fleet 전용 Claude 홈 하나에 받아 둔다(사용자 `~/.claude` 는 읽지도 쓰지도
 * 않는다). 사령관은 그중 고른 것만 `state.json` 의 `plugins` 로 기억하고, 그 사령관 세션과 그 사령관이 소유한 목표의
 * 지휘관·구성원 세션이 다음 턴(새 세션)부터 로컬 경로로 싣는다. 이 DTO 에는 파일 경로가 실리지 않는다 — 위치는 사람이
 * 입력한 저장소·URL 표기(`locator`)뿐이다.
 */

/** Anthropic 이 운영하는 기본 제공 마켓플레이스 — 처음부터 등록되고 지울 수 없다(끌 수는 있다). 이름은 marketplace.json 의 name. */
export const PRESET_MARKETPLACES = Object.freeze([
  { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official" },
  { name: "knowledge-work-plugins", repo: "anthropics/knowledge-work-plugins" },
  { name: "claude-for-financial-services", repo: "anthropics/financial-services" },
  { name: "claude-for-legal", repo: "anthropics/claude-for-legal" },
  { name: "life-sciences", repo: "anthropics/life-sciences" },
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
}

/** 플러그인이 싣는 구성 요소 수. 아직 받지 않아 모르면 카탈로그 항목의 `components` 가 없다. */
export interface PluginComponents {
  readonly skills: number;
  readonly agents: number;
  readonly commands: number;
  readonly hooks: number;
  readonly mcp: number;
}

export interface PluginCatalogEntry {
  /** `plugin@marketplace`. */
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly description?: string;
  readonly version?: string;
  readonly components?: PluginComponents;
  /**
   * 설치하면 사령관 권한으로 실행되는 명령(훅·stdio MCP) — 사람이 신뢰를 확인하는 원문. 받은 뒤에만 안다.
   * 한 줄씩 `훅 <이벤트> · <명령>` 이 아니라 구조로 준다: 화면이 문구를 고른다.
   */
  readonly runs?: readonly { readonly kind: "hook" | "mcp"; readonly label: string; readonly command: string }[];
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
  | "trust_required"
  | "unavailable";

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
 * - `commodore/plugins/set` { commodoreId, pluginId, installed, trusted? } → CommodoreStateView
 *   실행 명령이 있는 플러그인을 처음 설치할 때 trusted 가 없으면 trust_required 로 거절한다.
 */
export const marketplaceAddSchema = z.object({
  source: z.string().trim().min(1).max(MAX_MARKETPLACE_SOURCE),
  ref: z.string().trim().min(1).max(MAX_MARKETPLACE_REF).optional(),
}).strict();
export const marketplaceNameRefSchema = z.object({ name: marketplaceNameSchema }).strict();
export const marketplaceEnableSchema = z.object({ name: marketplaceNameSchema, enabled: z.boolean() }).strict();
export const marketplaceUpdateSchema = z.object({ name: marketplaceNameSchema.optional() }).strict();
export const pluginInspectSchema = z.object({ pluginId: pluginIdSchema }).strict();
export const commodorePluginSetSchema = z.object({
  commodoreId: z.string().min(1).max(128),
  pluginId: pluginIdSchema,
  installed: z.boolean(),
  trusted: z.boolean().optional(),
}).strict();
