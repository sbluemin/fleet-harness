import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type {
  ClientApiCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
  ConsoleTheme,
} from "../plugin/types.js";

/**
 * 페인(Pane) — 표면 안의 한 '열'이다.
 *
 * 표면은 그릇이고 페인은 열이다. 이 구분이 계약 전체의 축이다: 표면 하나가 페인 여럿을
 * 나란히 담고, 기하·분할선·포커스·캡션은 표면(호스트)이 소유하며, 플러그인은 페인 본문만
 * 그린다. 1단으로 보일 때 표면과 첫 페인이 눈으로 겹치지만 층위는 다르다.
 *
 * 페인은 두 마운트 중 하나에 선다 — 레일 표면(레일 슬롯 안, 폭 가변)과 확대 표면(캔버스를
 * 덮는 비모달 작업면). 같은 페인이 마운트만 바꿔 이동하는 것이 '확대'이며, 두 마운트가 같은
 * 어휘를 쓰기 때문에 그 이동이 번역 없이 성립한다.
 *
 * 기여는 서로를 모른다. 플러그인은 페인을 독립으로 등록하고, 어느 페인이 언제 서는지는
 * 등록이 아니라 런타임 호출(`ctx.panes.open`)이 정한다. 그래서 primary 없이 detail만
 * 등록하는 것도, 다른 플러그인의 페인을 여는 것도 계약 위반이 아니다.
 */
export interface PaneDescriptor {
  /**
   * 플러그인 안에서 고유해야 한다. 호스트는 `${pluginId}:${id}`로 이름공간을 나누므로
   * 다른 플러그인과 겹쳐도 되고, 이 전체 이름이 곧 `panes.open`의 주소다.
   */
  readonly id: string;
  /**
   * 이 페인이 표면 안에서 서는 자리.
   *
   * - `primary` — 표면이 열리면 기본으로 서는 열. 목록·트리·계기판이 여기 온다.
   * - `detail` — 무언가를 열었을 때 옆에 서는 열. 문서·뷰어·작업면이 여기 온다.
   * - `aside` — 본문에 종속된 좁은 부속 열. 목차가 대표적이다. 폭은 호스트가 정한다.
   *
   * role은 시각 배치가 아니라 의미다. 호스트는 이 값으로 순서·기본 폭·좁은 화면에서
   * 무엇을 먼저 접을지를 정한다.
   */
  readonly role: PaneRole;
  /** 이 페인이 설 수 있는 마운트. 둘 다 적으면 확대 이동이 가능한 페인이 된다. */
  readonly mounts: readonly PaneMount[];
  /**
   * 캡션에 설 이름. 페인 종류가 아니라 **지금 그 페인이 담은 것**을 말하므로 항상 컨텍스트를
   * 받는다 — 한 페인 안에서 문서를 갈아타면 이름도 따라간다. 고정 이름은 `() => "Shell"`처럼
   * 쓴다(`LocalizedText`가 이미 함수형을 포함해, 유니온으로 두면 런타임에 두 함수를 구분할
   * 수 없다).
   */
  readonly title: (ctx: PaneContext) => LocalizedText;
  readonly render: (ctx: PaneContext) => ReactNode;
  /**
   * 캡션의 동작 선반. 밴드 자체는 호스트 소유다 — 기하·면·모서리와 닫기·확대는 호스트가
   * 그리고, 이 자리에는 그 페인만 아는 동작(문서 히스토리 같은)이 온다.
   *
   * 버튼은 `@fleet-console/sdk/components/caption-actions`로 만든다. 호출부가 자기 마크업을
   * 실어 오면 한 줄에 두 벌의 문법이 서기 때문이다.
   */
  readonly captionActions?: (ctx: PaneContext) => ReactNode;
  /**
   * 캡션 없이 본문만 그린다. Operation companion의 `hideCaption`과 같은 뜻이며, 캡션 한 줄이
   * 세로 예산을 먹는 것이 손해인 페인(계기판처럼 자기 머리를 이미 가진 본문)을 위한 것이다.
   *
   * 캡션이 없으면 닫기·확대도 없다. 그 페인은 자기를 닫지 못하므로, 표면이 닫힐 때 함께 닫힌다.
   */
  readonly hideCaption?: boolean;
  /**
   * 이 페인이 이 폭보다 좁아지지 않도록 분할선 드래그를 막는다(px). 생략하면 호스트 기본값을
   * 쓴다. 상한은 없다 — 좁아지는 쪽만 막는다.
   */
  readonly minWidth?: number;
  /** 처음 설 때의 폭(px). 사용자가 분할선을 옮기면 그 값이 이긴다. */
  readonly defaultWidth?: number;
  /**
   * 닫아도 본문을 살려 둔다.
   *
   * 계약의 기본은 닫기=언마운트다. 그런데 콘솔에는 그러면 안 되는 본문이 있다 — PTY와
   * WebSocket을 든 터미널, 읽던 자리와 스트림을 든 문서, 커밋 초안을 든 스테이징. 이들이
   * 지금 각자 portal parking·DOM relocate·`hidden` 동시 마운트로 지키고 있는 것을 계약이
   * 대신 받는다.
   *
   * 살아 있는 페인은 `ctx.visible === false`로 그 사실을 통보받는다. 보이지 않는 동안에도
   * 렌더는 계속되므로, 값비싼 작업은 `visible`을 보고 스스로 멈춰야 한다. 호스트는 주차된
   * 서브트리를 `inert`와 `aria-hidden`으로 격리해 포커스와 보조기술에서 뺀다.
   */
  readonly keepAlive?: boolean;
  /**
   * 이 페인이 팔레트 검색 결과를 낼 수 있다면 그 공급자.
   *
   * 검색은 페인에 붙는다. 레일 엔트리가 아니라 페인에 붙는 이유는 착지 때문이다 — 결과를
   * 고르면 호스트는 '어느 페인에 어떤 params로' 열지를 알아야 하고, 그 답을 아는 것은
   * 결과를 만든 페인이다.
   */
  readonly search?: PaneSearchProvider;
}

export type PaneRole = "primary" | "detail" | "aside";

export type PaneMount = "rail" | "expanded";

/**
 * 페인 본문이 받는 것.
 *
 * 기하·포커스·주소는 호스트가 소유하므로 여기서는 **통보**만 받는다. 폭을 지시하거나 포커스를
 * 뺏는 API는 없다 — 넓어지고 싶으면 `minWidth`를 선언하고, 실제로 놓인 폭은 `width`로 알며,
 * 컨테이너 쿼리로 스스로 열화한다.
 */
export interface PaneContext {
  /** 서술자가 선언한 id에 플러그인 이름공간이 붙은 값. `panes.open`의 주소와 같다. */
  readonly paneId: string;
  /** 같은 페인을 두 자리에 띄웠을 때 둘을 가르는 id. */
  readonly instanceId: string;
  /** 무엇을 열었는지 — 페인이 스스로 정의한 사전. 주소 복원의 단위이기도 하다. */
  readonly params: Readonly<Record<string, string>>;
  readonly role: PaneRole;
  /** 지금 이 페인이 서 있는 마운트. 확대·축소로 바뀐다. */
  readonly mount: PaneMount;
  /** 실제로 놓인 폭(px). 분할선 드래그·창 리사이즈에 따라 갱신된다. */
  readonly width: number;
  /**
   * 지금 화면에 보이는가. `keepAlive` 페인은 닫힌 뒤에도 렌더되지만 이 값이 false가 된다.
   * 폴링·구독·애니메이션은 이 값을 보고 스스로 멈춰야 한다 — 호스트는 렌더를 멈추지 않는다.
   */
  readonly visible: boolean;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly panes: PanesCapability;
  /**
   * 이 페인 인스턴스의 수명에 묶인 신호. 페인이 실제로 헐릴 때 abort된다(`keepAlive` 페인은
   * 닫혀도 abort되지 않는다 — 살아 있으니까).
   *
   * 서버 요청·watcher·타이머를 여기 묶으면, 다른 Theater로 갈아탄 뒤 옛 응답이 새 페인에
   * 착지하는 일이 계약 수준에서 막힌다.
   */
  readonly signal: AbortSignal;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
}

/**
 * 페인을 여닫는 창구.
 *
 * 이것이 '1단↔2단 전이'의 자리다. 등록은 독립이고 전이는 호출이다 — 목록 페인이 문서 페인을
 * 열 때 둘은 서로의 구현을 모르고, 페인 id와 params만 주고받는다.
 */
export interface PanesCapability {
  /** 페인 하나를 연다. 같은 페인이 이미 서 있으면 params만 갈아 끼운다. */
  open(request: PaneOpenRequest): void;
  /** 페인을 닫는다. id를 생략하면 이 페인 자신을 닫는다. */
  close(paneId?: string): void;
  /** 같은 페인에서 다른 대상으로 갈아탄다(주소도 함께 바뀐다). */
  replaceParams(next: Readonly<Record<string, string>>): void;
  /** 그 페인이 지금 서 있는가. `keepAlive`로 살아만 있는 상태는 false다. */
  isOpen(paneId: string): boolean;
}

export interface PaneOpenRequest {
  readonly paneId: string;
  readonly params?: Readonly<Record<string, string>>;
  /**
   * 어느 마운트에 열지. 생략하면 호스트가 정한다 — 그 페인이 이미 서 있으면 그 자리에,
   * 아니면 서술자의 첫 마운트에.
   */
  readonly mount?: PaneMount;
  /** 열면서 포커스까지 옮길지. 기본은 옮긴다. */
  readonly focus?: boolean;
}

export interface PaneSearchRequest {
  readonly query: string;
  readonly theaterId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
  readonly language?: ConsoleLocale;
}

/**
 * 팔레트 결과 하나.
 *
 * `activate`가 `PaneTarget`을 **돌려주는** 것이 계약의 핵심이다. 예전처럼 콜백 안에서
 * 모듈 싱글턴에 타깃을 적어 두고 나중에 마운트된 패널이 그것을 주워 가면, 늦게 뜨거나 다른
 * Theater에 붙은 페인이 그 값을 잘못 소비한다. 타깃을 값으로 돌려주면 호스트가 한 손짓으로
 * '어느 Theater의 어느 페인을 어떤 params로 열고 포커스까지' 처리한다.
 */
export interface PaneSearchResult {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** 열 자리를 값으로 돌려준다. 아무것도 열지 않는 결과라면 반환을 생략한다. */
  readonly activate: () => PaneTarget | void | Promise<PaneTarget | void>;
  /** "info"는 선택 불가 메타데이터 행 — 키보드 이동과 활성화에서 빠진다. */
  readonly kind?: "info";
}

export type PaneSearchProvider = (request: PaneSearchRequest) => Promise<readonly PaneSearchResult[]>;

/** 팔레트·딥링크가 착지할 자리. 호스트가 Theater 전환부터 포커스까지 한 번에 수행한다. */
export interface PaneTarget {
  readonly paneId: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly theaterId?: string;
  readonly mount?: PaneMount;
}
