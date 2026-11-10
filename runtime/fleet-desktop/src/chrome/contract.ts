/**
 * 브라우저 크롬 문서(주소줄·레일)와 셸 main 사이의 좁은 양방향 계약. 두 쪽이 같은 타입 파일을 쓴다 — 문서는 이 파일의 타입만 import 하고
 * 번들되며, main 은 아래 검증기로 문서가 보낸 문장을 한 번 더 걸러 받는다. 문서는 Node 도 raw IPC 도 모르고, main 에게 말하는 길은
 * `console-message` 한 줄 JSON, 문서가 받는 길은 main 이 `executeJavaScript` 로 호출하는 `__fleetChrome` 뿐이다.
 */
import type { DesktopBrowserChrome } from "@fleet-console/protocol/desktop";

export type ChromeRole = "bar" | "rail" | "stage";
export const CHROME_CHANNEL = "fleet-chrome";

export interface ChromeSuggestion { readonly value: string; readonly title: string; readonly favicon: string | null; readonly history: boolean }
export interface ChromeImportSources {
  readonly available: boolean;
  readonly reason: "chrome_required" | "no_profiles" | null;
  readonly profiles: readonly { readonly id: string; readonly name: string; readonly account: string | null }[];
}
export type ChromeTabsOrientation = "vertical" | "horizontal";
export type ChromeOverlay =
  | { readonly kind: "menu" }
  /** 스페이스 선택 화면 — 디폴트와 모든 사령관 스페이스를 그리드로 보여 준다. */
  | { readonly kind: "spaces" }
  /** 탭 표시줄 우클릭 메뉴 — 주소줄 문서 좌표(CSS px)의 그 자리에 뜬다. */
  | { readonly kind: "tabs-menu"; readonly x: number; readonly y: number }
  | { readonly kind: "suggestions" }
  | { readonly kind: "import"; readonly sources: ChromeImportSources }
  | { readonly kind: "switch"; readonly profile: string | null }
  | { readonly kind: "clear" }
  | { readonly kind: "annotate" };

export interface ChromeColors { readonly scheme: "dark" | "light"; readonly tokens: Readonly<Record<string, string>>; readonly fonts?: Readonly<Record<string, { readonly family: string; readonly size: number }>> }

/** main 이 두 문서에 똑같이 밀어 넣는 상태. 문서는 이것을 그리기만 한다. */
export interface ChromeUiState {
  readonly lang: "ko" | "en";
  readonly platform: string;
  readonly mode: "pane" | "window";
  readonly colors: ChromeColors | null;
  readonly chrome: DesktopBrowserChrome | null;
  /** 지금 화면에 띄운 스페이스 — 셸이 정한다. 레일은 이 스페이스의 탭만 그린다. */
  readonly spaceId: string;
  readonly pinned: boolean;
  /** 레일이 호버·포커스로 펼쳐졌는가(고정과 별개). */
  readonly expanded: boolean;
  /** 탭 표시줄의 방향 — 세로 레일(주소줄 아래 왼쪽) 또는 가로 표시줄(주소줄 위). 가로일 때 맨 위 줄은 탭 표시줄이다. */
  readonly orientation: ChromeTabsOrientation;
  /** 접힌 세로 레일이 포인터를 올리면 스스로 펼쳐지는가. */
  readonly autoExpand: boolean;
  /** 창 모드의 macOS 신호등 자리(DIP). 칸이면 0. */
  readonly leading: number;
  /** 윈도우 캡션 단추가 차지하는 오른쪽 자리(DIP). */
  readonly trailing: number;
  /** 주소줄 뷰 안에서 페이지가 놓인 자리(주소줄 뷰 왼쪽 위 기준 CSS px). 대화상자·주석이 이 자리를 덮는다. */
  readonly page: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Console 창 배율 — 크롬 문서의 CSS px 하나는 페이지 CSS px `zoom` 개와 같다(주석 좌표 변환). */
  readonly zoom: number;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly info: { readonly text: string; readonly action?: string } | null;
  readonly overlay: ChromeOverlay | null;
  /** 오버레이가 요구한 뷰 확대가 적용됐는가 — 메뉴는 이 값이 참일 때만 그린다. */
  readonly overlayReady: boolean;
  readonly suggest: { readonly enabled: boolean; readonly prompted: boolean; readonly saving: boolean; readonly failed: boolean } | null;
  readonly suggestions: readonly ChromeSuggestion[];
  readonly captureAvailable: boolean;
  readonly importUnavailable: boolean;
  /** 주소줄에 되돌려 줄 글 — 다른 표면에서 쓰던 주소 초안. */
  readonly draft: string | null;
}

export type ChromeAction =
  | { readonly action: "navigate"; readonly url: string }
  | { readonly action: "new-tab" }
  | { readonly action: "select-tab"; readonly id: string }
  | { readonly action: "close-tab"; readonly id: string }
  | { readonly action: "select-space"; readonly id: string }
  /** main 이 스스로 내는 동작 — 표시 스페이스를 맞추려고 그 탭을 띄우거나(`id`) 표시 탭을 내린다(`null`). 문서가 보낸 문장으로는 만들어지지 않는다. */
  | { readonly action: "show-tab"; readonly id: string | null }
  | { readonly action: "pin"; readonly pinned: boolean }
  | { readonly action: "expand"; readonly expanded: boolean }
  /** 탭 표시줄의 빈 곳을 우클릭했다 — 좌표는 그 문서의 CSS px. */
  | { readonly action: "tabs-menu"; readonly x: number; readonly y: number }
  | { readonly action: "orientation"; readonly orientation: ChromeTabsOrientation }
  | { readonly action: "auto-expand"; readonly enabled: boolean }
  | { readonly action: "toggle-mode" }
  | { readonly action: "open-external" }
  | { readonly action: "suggest"; readonly query: string }
  | { readonly action: "suggest-settings"; readonly enabled: boolean }
  | { readonly action: "overlay"; readonly kind: "menu" | "spaces" | "suggestions" | null }
  | { readonly action: "attach-screenshot" }
  | { readonly action: "annotate" }
  | { readonly action: "annotate-inspect"; readonly x: number; readonly y: number; readonly seq: number }
  | { readonly action: "annotate-capture"; readonly seq: number }
  | { readonly action: "annotate-done"; readonly png: string | null }
  | { readonly action: "viewport"; readonly preset: "responsive" | "mobile" | "tablet" }
  | { readonly action: "profile"; readonly profile: string | null }
  | { readonly action: "profile-confirm"; readonly profile: string | null }
  | { readonly action: "default-profile"; readonly profile: string | null }
  | { readonly action: "import-open" }
  | { readonly action: "import-run"; readonly profileId: string }
  | { readonly action: "clear-open" }
  | { readonly action: "clear-run" }
  | { readonly action: "dialog-close" }
  | { readonly action: "info-action" }
  | { readonly action: "draft"; readonly value: string | null }
  | { readonly action: "ready" };

const PROFILES = new Set<unknown>([null, "default"]);
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/u.test(value);

/** 문서가 보낸 `[채널, 역할, 동작, 본문]` 문장 하나를 동작 하나로. 모양이 어긋나면 null — 무시된다. */
export function readChromeMessage(text: string): { readonly role: ChromeRole; readonly action: ChromeAction } | null {
  if (text.length > 4_000_000) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== CHROME_CHANNEL || (value[1] !== "bar" && value[1] !== "rail" && value[1] !== "stage")) return null;
  const name = value[2];
  const body = (typeof value[3] === "object" && value[3] !== null ? value[3] : {}) as Record<string, unknown>;
  const role = value[1] as ChromeRole;
  const make = (action: ChromeAction | null) => action ? { role, action } : null;
  switch (name) {
    case "navigate": return make(str(body.url, 4096) ? { action: "navigate", url: body.url } : null);
    case "new-tab": case "toggle-mode": case "open-external": case "attach-screenshot": case "annotate": case "import-open": case "clear-open": case "clear-run": case "dialog-close": case "info-action": case "ready":
      return make({ action: name });
    case "select-tab": case "close-tab": case "select-space": return make(safeId(body.id) ? { action: name, id: body.id } : null);
    case "pin": return make(typeof body.pinned === "boolean" ? { action: "pin", pinned: body.pinned } : null);
    case "expand": return make(typeof body.expanded === "boolean" ? { action: "expand", expanded: body.expanded } : null);
    case "tabs-menu": return make(typeof body.x === "number" && typeof body.y === "number" && Number.isFinite(body.x) && Number.isFinite(body.y) ? { action: "tabs-menu", x: body.x, y: body.y } : null);
    case "orientation": return make(body.orientation === "vertical" || body.orientation === "horizontal" ? { action: "orientation", orientation: body.orientation } : null);
    case "auto-expand": return make(typeof body.enabled === "boolean" ? { action: "auto-expand", enabled: body.enabled } : null);
    case "suggest": return make(str(body.query, 2048) ? { action: "suggest", query: body.query } : null);
    case "suggest-settings": return make(typeof body.enabled === "boolean" ? { action: "suggest-settings", enabled: body.enabled } : null);
    case "overlay": return make(body.kind === null || body.kind === "menu" || body.kind === "spaces" || body.kind === "suggestions" ? { action: "overlay", kind: body.kind } : null);
    case "annotate-inspect": return make(typeof body.x === "number" && typeof body.y === "number" && Number.isFinite(body.x) && Number.isFinite(body.y) && typeof body.seq === "number" ? { action: "annotate-inspect", x: body.x, y: body.y, seq: body.seq } : null);
    case "annotate-capture": return make(typeof body.seq === "number" ? { action: "annotate-capture", seq: body.seq } : null);
    case "annotate-done": return make(body.png === null || (typeof body.png === "string" && body.png.length <= 3_500_000) ? { action: "annotate-done", png: body.png as string | null } : null);
    case "viewport": return make(body.preset === "responsive" || body.preset === "mobile" || body.preset === "tablet" ? { action: "viewport", preset: body.preset } : null);
    case "profile": case "profile-confirm": case "default-profile": return make(PROFILES.has(body.profile) ? { action: name, profile: body.profile as string | null } : null);
    case "import-run": return make(str(body.profileId, 200) && body.profileId.length > 0 ? { action: "import-run", profileId: body.profileId } : null);
    case "draft": return make(body.value === null || str(body.value, 4096) ? { action: "draft", value: body.value as string | null } : null);
    default: return null;
  }
}
