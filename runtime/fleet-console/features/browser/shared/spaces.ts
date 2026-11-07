/**
 * 플릿 브라우저 스페이스 계약 — 호스트(BrowserService·라우트·MCP)와 패널이 함께 읽는 모양. Node 를 쓰지 않는다.
 *
 * 브라우저는 사령관마다 하나다(`commodore:<commodoreId>`). 같은 사령관의 사령관 대화와 그 Objective 들이 이 브라우저를
 * 함께 쓰고, 다른 사령관의 브라우저와는 쿠키·탭·화면이 모두 갈린다. 브라우저 안은 크롬 탭 그룹 같은 스페이스로 나뉜다:
 * - 사령관 스페이스(`COMMODORE_SPACE_ID`) — 사령관 대화의 에이전트가 쓴다.
 * - Objective 스페이스(id = Objective 루트 id) — 그 Objective 의 지휘관과 구성원(자식 세션)이 함께 쓴다.
 * 사령관 단위로 묶이지 않는 세션(scuttlebutt 등)은 자기만의 브라우저 하나에 `SESSION_SPACE_ID` 한 스페이스로 선다.
 *
 * 화면과 에이전트의 대상은 나뉜다.
 * - 표시 탭(`activeTabId`)은 사람의 것이다. 패널의 탭·스페이스 선택만 바꾸고, 에이전트는 `tabs_select(show:true)` 로만 바꾼다.
 * - 작업 탭은 호출한 세션(참가자)마다 따로다. 자기 스페이스의 탭만 작업 탭이 되며, 그 탭이 닫히면 비워진다.
 * - 에이전트는 다른 스페이스의 탭을 tabId 로 읽기만 할 수 있다(입력·이동·닫기·뷰포트는 거절).
 */

export const BROWSER_COMMODORE_PREFIX = "commodore:";
export const COMMODORE_SPACE_ID = "commodore";
export const SESSION_SPACE_ID = "session";
/** 스페이스 하나가 동시에 여는 탭의 상한. */
export const BROWSER_SPACE_TAB_LIMIT = 8;
/** 브라우저 하나(사령관 하나) 전체의 탭 상한. */
export const BROWSER_TOTAL_TAB_LIMIT = 24;

export type BrowserSpaceKind = "commodore" | "objective" | "session";

/** 사령관의 브라우저 id. Objective id(UUID)와 겹치지 않는 접두를 쓴다. */
export function commodoreBrowserId(commodoreId: string): string {
  return `${BROWSER_COMMODORE_PREFIX}${commodoreId}`;
}

export function commodoreOfBrowser(browserId: string): string | null {
  return browserId.startsWith(BROWSER_COMMODORE_PREFIX) ? browserId.slice(BROWSER_COMMODORE_PREFIX.length) || null : null;
}

export function spaceKindOf(spaceId: string): BrowserSpaceKind {
  return spaceId === COMMODORE_SPACE_ID ? "commodore" : spaceId === SESSION_SPACE_ID ? "session" : "objective";
}

/** 상태 프레임의 스페이스 한 칸. 탭이 하나라도 있거나 에이전트가 쓰는 중인 스페이스만 실린다. */
export interface BrowserSpaceState {
  readonly id: string;
  readonly kind: BrowserSpaceKind;
  /** 사람이 읽는 이름 — Objective 제목, 사령관 이름. 모르면 빈 문자열이고 패널이 기본 낱말을 쓴다. */
  readonly label: string;
  /** 이 스페이스의 에이전트가 지금 브라우저를 쓰는 중인가(조작 중 표시). */
  readonly driving: boolean;
  /** 어느 참가자의 작업 탭인 이 스페이스의 탭들. 패널은 탭에 작업 표식을 단다. */
  readonly agentTabIds: readonly string[];
  /** 사람이 이 스페이스에서 마지막으로 띄운 탭. 스페이스를 고르면 이 탭이 표시된다. */
  readonly lastShownTabId: string | null;
}

/**
 * 상태 프레임에 더해지는 스페이스 필드. 프레임은 사령관 브라우저 하나에 하나씩 흐르고(`browserId`), 탭마다 `spaceId` 가 붙는다.
 * `homeSpaceId` 는 `GET …/objectives/:id/state` 응답에만 실린다 — 요청한 id(Objective 이면 그 루트, 사령관 브라우저면
 * 사령관 스페이스)의 스페이스이며, 스트림 프레임에는 없다(한 프레임을 여러 대화가 함께 받는다).
 */
export interface BrowserSpacesFrame {
  readonly browserId: string;
  readonly spaces: readonly BrowserSpaceState[];
  /** 표시 탭이 속한 스페이스. 탭이 없으면 null. */
  readonly displayedSpaceId: string | null;
}

/**
 * 패널이 부르는 라우트(모두 `/api/v1/browser/objectives/:id/…`, `:id` 는 Objective id 또는 사령관 브라우저 id).
 * - `POST space` `{ spaceId }` — 그 스페이스를 화면에 띄운다(마지막으로 띄운 탭, 없으면 그 스페이스의 첫 탭). 응답은 상태.
 * - `POST tabs` `{ action: "create", url?, spaceId? }` — spaceId 가 없으면 요청한 id 의 스페이스에 연다. 사람은 어느 스페이스든 연다.
 * - `POST tabs` `{ action: "select" | "close", tabId }`, `navigate`, `inspect` — tabId 로 스페이스를 가린다. 사람은 제한이 없다.
 * - `POST viewport` — 표시 탭의 스페이스 뷰포트를 바꾼다.
 * - `GET /api/v1/browser/sessions/resolve?pluginId=commodore&scopeId=commodore:<id>` — 세션이 시작하기 전에도 사령관 브라우저 id 를 답한다.
 */
export type BrowserSpaceRoute = "space";
