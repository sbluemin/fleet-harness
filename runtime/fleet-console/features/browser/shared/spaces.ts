/**
 * 플릿 브라우저 스페이스 계약 — 호스트(BrowserService·라우트·MCP)와 패널이 함께 읽는 모양. Node 를 쓰지 않는다.
 *
 * 브라우저는 Console 전체에 하나다(`BROWSER_GLOBAL_ID`). 모든 사령관·Objective·일반 세션이 같은 탭 집합과
 * 표시 탭, 쿠키·로그인 프로필을 함께 쓴다. 임시 프로필이어도 파티션은 하나다. 예전 사령관별 탭은 옮기지 않는다.
 * 브라우저 안은 크롬 탭 그룹 같은 스페이스로 나뉜다:
 * - 사령관 스페이스(`commodore:<commodoreId>`) — 사령관마다 별개이며 그 사령관 대화의 에이전트가 쓴다.
 * - Objective 스페이스(id = Objective 루트 id) — 그 Objective 의 지휘관과 구성원(자식 세션)이 함께 쓴다.
 * - 일반 세션 스페이스(`session:<sessionOwnerId>`) — 플러그인 세션 등 사령관에 묶이지 않는 세션이 쓴다.
 * 사람이 직접 연 탭은 사람 스페이스(`HUMAN_SPACE_ID`)에 선다. 패널은 이를 그룹 없이 따로 그린다.
 * 스페이스는 탭이 있거나 에이전트가 쓰는 중일 때만 프레임에 실리고, 어느 대화에서 열든 전체 목록이 같다.
 *
 * 화면과 에이전트의 대상은 나뉜다.
 * - 표시 탭(`activeTabId`)은 사람의 것이다. 패널의 탭·스페이스 선택만 바꾸고, 에이전트는 `tabs_select(show:true)` 로만 바꾼다.
 * - 작업 탭은 호출한 세션(참가자)마다 따로다. 자기 스페이스의 탭만 작업 탭이 되며, 그 탭이 닫히면 비워진다.
 * - 에이전트는 다른 사령관을 포함한 다른 스페이스의 탭을 tabId 로 읽기만 할 수 있다(입력·이동·닫기·뷰포트·JavaScript 는 거절).
 * - 동시 생성 예약까지 세어 공간당 8개, Console 전체 24개로 네이티브 뷰의 자원 사용을 제한한다.
 */

/** 사령관을 몰라도 패널·분리 창이 쓸 수 있는 Console 전역 브라우저 id. */
export const BROWSER_GLOBAL_ID = "global";
export const BROWSER_COMMODORE_PREFIX = "commodore:";
export const SESSION_SPACE_PREFIX = "session:";
/** 문맥 없이 직접 서비스에 여는 에이전트 탭의 기본 공간. MCP 는 언제나 고유한 spaceId 를 싣는다. */
export const SESSION_SPACE_ID = "session";
/** 사람이 직접 연 탭이 서는 스페이스. 에이전트의 `spaceId` 는 이 값이 될 수 없어, 에이전트에게는 늘 읽기 전용이다. */
export const HUMAN_SPACE_ID = "human";
/** 스페이스 하나가 동시에 여는 탭의 상한. */
export const BROWSER_SPACE_TAB_LIMIT = 8;
/** Console 전역 브라우저 전체의 탭 상한. */
export const BROWSER_TOTAL_TAB_LIMIT = 24;

export type BrowserSpaceKind = "commodore" | "objective" | "session" | "human";

export function commodoreSpaceId(commodoreId: string): string {
  return `${BROWSER_COMMODORE_PREFIX}${commodoreId}`;
}

export function commodoreOfSpace(spaceId: string): string | null {
  return spaceId.startsWith(BROWSER_COMMODORE_PREFIX) ? spaceId.slice(BROWSER_COMMODORE_PREFIX.length) || null : null;
}

export function sessionSpaceId(sessionOwnerId: string): string {
  return `${SESSION_SPACE_PREFIX}${sessionOwnerId}`;
}

export function spaceKindOf(spaceId: string): BrowserSpaceKind {
  return commodoreOfSpace(spaceId) ? "commodore" : spaceId === SESSION_SPACE_ID || spaceId.startsWith(SESSION_SPACE_PREFIX) ? "session" : spaceId === HUMAN_SPACE_ID ? "human" : "objective";
}

/** 상태 프레임의 스페이스 한 칸. 탭이 하나라도 있거나 에이전트가 쓰는 중인 스페이스만 실린다. 사람 스페이스(`kind: "human"`)는 그룹이 아니라 그룹 없는 탭들이다. */
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
 * 상태 프레임에 더해지는 스페이스 필드. 스트림은 Console 전체에 한 프레임이며 `browserId` 와 호환 필드
 * `objectiveId` 는 모두 `BROWSER_GLOBAL_ID` 다. 탭마다 `spaceId` 가 붙고 모든 사령관의 스페이스가 함께 실린다.
 * `homeSpaceId` 는 `GET …/objectives/:id/state` 응답에만 실린다 — Objective(자식 포함)는 루트 id,
 * 사령관 scope 는 `commodore:<id>`, 일반 세션 alias 는 `session:<alias>`, 전역 id 직접 요청은 `human` 이다.
 * 스트림에는 HOME 이 없다. HOME 은 호출 문맥일 뿐 표시 탭·전체 상태를 바꾸지 않는다.
 */
export interface BrowserSpacesFrame {
  readonly browserId: string;
  readonly spaces: readonly BrowserSpaceState[];
  /** 표시 탭이 속한 스페이스. 탭이 없으면 null. */
  readonly displayedSpaceId: string | null;
}

/**
 * 패널이 부르는 라우트(모두 `/api/v1/browser/objectives/:id/…`). `:id` 는 전역 id, Objective id,
 * 사령관 scope(`commodore:<id>`) 또는 일반 세션 alias 다. 모두 같은 브라우저를 가리키며 state 의 HOME 만 다르다.
 * - `POST space` `{ spaceId }` — 그 스페이스를 화면에 띄운다(마지막으로 띄운 탭, 없으면 그 스페이스의 첫 탭). 응답은 상태.
 * - `POST tabs` `{ action: "create", url?, spaceId? }` — spaceId 가 없으면 사람 스페이스(`HUMAN_SPACE_ID`)에 연다. 사람은 어느 스페이스든 연다.
 * - `POST tabs` `{ action: "select" | "close", tabId }`, `navigate`, `inspect` — tabId 로 스페이스를 가린다. 사람은 제한이 없다.
 * - `POST viewport` — 표시 탭의 스페이스 뷰포트를 바꾼다.
 * - `GET /api/v1/browser/sessions/resolve?pluginId=commodore&scopeId=commodore:<id>` — 세션 시작 전에도
 *   `{ ownerId: BROWSER_GLOBAL_ID, homeSpaceId: "commodore:<id>" }` 를 답한다. 미해결 세션은 두 필드 모두 null 이다.
 */
export type BrowserSpaceRoute = "space";
