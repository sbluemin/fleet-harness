/**
 * 독립 Antigravity CLI(`agy`)가 전역 플러그인을 실을 때 사람이 알아야 할 몫 — 최근 agy 실행 한 번의 보고다.
 *
 * 보고는 실행할 때 하는 변환에서 나온다(변환 실패·훅 이벤트는 agy를 돌려 봐야 안다). 그래서 이 Console에서 agy를 아직
 * 띄우지 않았으면 비어 있고, 다음 실행이 갈아 끼우며, Console이 다시 뜨면 비워진다. 알릴 것이 있는 플러그인만 싣는다 —
 * 사람이 agy에 직접 설치한 이름(그 설치본을 쓴다)과 그대로 실린 플러그인은 없다. 문장이 아니라 구조로 준다: 화면이 문구를 고른다.
 */
export type AntigravityPluginSkip =
  /** LSP 서버 — agy에 대응하는 구성 요소가 있지 않다. */
  | { readonly kind: "lsp" }
  /** 출력 스타일 — agy에 대응하는 구성 요소가 있지 않다. */
  | { readonly kind: "output-styles" }
  /** 옮겨 싣지 않은 MCP 서버(동적 헤더 `headersHelper`, 옛 SSE 전송). `name`은 플러그인 선언의 서버 이름이다. */
  | { readonly kind: "mcp-server"; readonly name: string }
  /** agy에 그 이벤트가 있지 않아 싣지 않은 훅. */
  | { readonly kind: "hook"; readonly event: string }
  /** 변환기가 건너뛴다고 알린, 위로 분류되지 않은 몫. */
  | { readonly kind: "other" };

export interface AntigravityPluginNote {
  /** `plugin@marketplace`. */
  readonly pluginId: string;
  /** 로그인이 필요한 원격 MCP 서버 이름 — agy는 세션 범위 플러그인에 로그인 수단을 주지 않는다. agy에 직접 설치하면 그쪽에서 로그인한다. */
  readonly signIn?: readonly string[];
  readonly skipped?: readonly AntigravityPluginSkip[];
  /** 이번 실행에서 변환하지 못해 실리지 않았다. 다음 실행 때 다시 변환한다. */
  readonly retry?: true;
}

const MAX_NAME = 128;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME ? value : null;
}

function parseSkip(raw: unknown): AntigravityPluginSkip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === "lsp" || row.kind === "output-styles" || row.kind === "other") return { kind: row.kind };
  if (row.kind === "mcp-server") { const name = text(row.name); return name ? { kind: "mcp-server", name } : null; }
  if (row.kind === "hook") { const event = text(row.event); return event ? { kind: "hook", event } : null; }
  return null;
}

/** `/standalone-cli/state`의 `slots.antigravity.pluginNotes`를 읽는다. 모양이 틀린 줄은 버린다. */
export function parseAntigravityPluginNotes(raw: unknown): readonly AntigravityPluginNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AntigravityPluginNote[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const pluginId = typeof row.pluginId === "string" && row.pluginId.length <= 256 ? row.pluginId : null;
    if (!pluginId) return [];
    const signIn = Array.isArray(row.signIn) ? row.signIn.flatMap((name) => { const value = text(name); return value ? [value] : []; }) : [];
    const skipped = Array.isArray(row.skipped) ? row.skipped.flatMap((skip) => { const value = parseSkip(skip); return value ? [value] : []; }) : [];
    const retry = row.retry === true;
    if (!signIn.length && !skipped.length && !retry) return [];
    return [{ pluginId, ...(signIn.length ? { signIn } : {}), ...(skipped.length ? { skipped } : {}), ...(retry ? { retry: true as const } : {}) }];
  });
}
