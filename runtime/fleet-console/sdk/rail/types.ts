import type { OpenFileRequest, OpenWikiEntryRequest, OpenResult } from "../navigation/index.js";
import type { PluginInstallContext } from "../plugin/types.js";
import type { ConversationToolScope, PaneTarget } from "../pane/types.js";
import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type { OpenLinkHandler } from "../link/types.js";
import type { ClientApiCapability, ClientExpandedSurfacesCapability, ClientRailCapability, ConsoleTheme } from "../plugin/types.js";
import type { OperationLaunchKind } from "../operations/types.js";
import type { PaneSearchProvider } from "../pane/types.js";

/** @deprecated Rail panels now always operate at the Theater root. */
export interface RailPathContext {
  readonly kind: "root" | "worktree" | "directory";
  readonly relPath: string | null;
  readonly label: string;
}

export interface RailPanelContext {
  readonly theaterId: string | null;
  /** @deprecated Always the Theater-root context. */
  readonly pathContext: RailPathContext;
  /** @deprecated Path selection is no longer supported. */
  readonly selectPathContext?: (relPath: string | null) => void;
  readonly api: ClientApiCapability;
  readonly requestExtraWidth?: (px: number | null) => void;
  readonly launchOperation?: (pluginId: string | null, kind: OperationLaunchKind) => void;
  /** 이 도구가 놓인 대화와 그 작업 위치 — 데스크톱 대화의 도구 캡슐·칸에서만 실린다(`ConversationToolScope`). */
  readonly conversation?: ConversationToolScope;
  /** rail 동작이 Operation 대신 확대 표면을 열 때 쓴다. */
  readonly surfaces?: ClientExpandedSurfacesCapability;
  /** 도킹할 수 있는 동작 엔트리가 자기 패널을 열고 닫을 때 쓰는 창구. */
  readonly rail?: ClientRailCapability;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  /**
   * 이 패널의 http(s) 링크를 여는 길. document bubble 라우터가 닿지 않는 자리
   * (stopPropagation을 쓰는 렌더 등)에서 명시 호출한다. 모르는 호스트는 싣지
   * 않으며, 없으면 앵커 기본 동작(외부 브라우저·새 탭)으로 떨어진다.
   */
  readonly openLink?: OpenLinkHandler;
}

export interface RailSearchRequest {
  readonly query: string;
  readonly theaterId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
  /** 결과 문자열을 로컬라이즈할 로케일 — 코어가 주입한다. */
  readonly language?: ConsoleLocale;
}

export interface RailSearchResult {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** 행 앞에 설 글리프. 생략하면 팔레트는 이 결과를 낸 레일 엔트리의 아이콘을 쓴다. */
  readonly icon?: ReactNode;
  readonly activate: () => void | Promise<void>;
  /** "info"는 선택 불가 메타데이터 행 — 키보드 이동과 활성화에서 빠지고 읽기 전용으로 렌더된다. */
  readonly kind?: "info";
  /** 질의가 이 결과의 대상을 정확히 가리킨다(예: Theater 상대 경로 일치). 팔레트는 그룹과 무관하게 맨 위에 둔다. */
  readonly exact?: boolean;
}

export type RailSearchProvider = (request: RailSearchRequest) => Promise<readonly RailSearchResult[]>;

interface RailContributionBase {
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon: ReactNode | (() => ReactNode);
  readonly side?: "right";
}

export type RailPanelDescriptor = RailContributionBase & ({
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly activate?: never;
  readonly surfaceId?: never;
  readonly search?: RailSearchProvider;
  /** @deprecated Core ignores this field; every panel is Theater-root scoped. */
  readonly pathAware?: boolean;
  readonly defaultWidth?: number;
  readonly preferredExtraWidth?: number;
} | {
  /** 패널을 펼치는 대신 즉시 실행하는 rail 동작. */
  readonly activate: (ctx: RailPanelContext) => void;
  /**
   * 이 동작이 여는 확대 표면의 id. 선언하면 그 표면이 슬롯을 차지하고 있는 동안 rail
   * 아이콘이 펼친 패널과 같은 문법으로 켜진다 — 지금 어디에 있는지를 말하는 자리다.
   *
   * 콜백이 아니라 선언인 이유는 반응성 때문이다. 호스트는 자기 표면 스토어를 구독하고
   * 있으므로 이 값이면 정확히 그 변화에 맞춰 다시 그린다. 콜백을 받으면 무엇에 의존하는지
   * 알 수 없어 열고 닫아도 아이콘이 옛 상태로 남는다.
   */
  readonly surfaceId?: string;
  readonly render?: never;
  readonly search?: never;
  readonly pathAware?: never;
  readonly defaultWidth?: never;
  readonly preferredExtraWidth?: never;
});

/**
 * 레일 엔트리 — 우측 레일의 아이콘 진입점 하나.
 *
 * 예전 `RailPanelDescriptor`는 진입점·본문·검색·기본폭을 한 객체로 묶었다. 그 결합 때문에
 * "아이콘만 있고 펼칠 패널은 없는" Shell이 판별 유니온의 예외 가지로 남았고, 페인을 독립
 * 등록으로 쪼갤 수도 없었다. 엔트리는 이제 **여는 손짓**만 안다.
 *
 * 무엇이 열리는가는 두 가지 중 하나다: `panes`에 적힌 페인들이 레일 표면에 서거나,
 * `activate`가 직접 무언가를 연다(Shell처럼 확대 표면을 바로 여는 경우).
 */
export interface RailEntryDescriptor {
  readonly handles?: {
    readonly openFile?: (request: OpenFileRequest, host: PluginInstallContext) => PaneTarget | OpenResult | Promise<PaneTarget | OpenResult>;
    readonly openWikiEntry?: (request: OpenWikiEntryRequest, host: PluginInstallContext) => void | OpenResult | Promise<void | OpenResult>;
  };
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon: ReactNode | (() => ReactNode);
  readonly side?: "right";
  /**
   * 이 도구가 다루는 범위. `theater`(기본)는 활성 Theater의 파일·저장소·Shell처럼 지금 서 있는
   * 작전구역을 다루고, `fleet`은 스킬·사용 한도처럼 Console 전체에 걸친다. 레일은 두 범위를
   * 구분선으로 갈라 세운다 — 순서는 범위 안에서 등록 순서 그대로다.
   */
  readonly scope?: "theater" | "fleet";
  /**
   * 이 엔트리가 레일 표면에 세우는 페인들의 id. 순서가 곧 왼쪽부터의 배치이며, 호스트는
   * 이 목록에서 `role: "primary"`인 것을 처음에 세우고 나머지는 `panes.open`을 기다린다.
   *
   * 비워 두면 이 엔트리는 표면을 열지 않는 순수 동작이 된다(`activate`가 있어야 한다).
   */
  readonly panes?: readonly string[];
  /**
   * 아이콘을 눌렀을 때 페인을 세우는 대신 실행할 동작. `panes`와 함께 쓰면 동작이 이긴다.
   */
  readonly activate?: (ctx: RailPanelContext) => void;
  /**
   * 이 엔트리가 여는 확대 표면의 id. 선언하면 그 표면이 서 있는 동안 아이콘이 펼친 표면과
   * 같은 문법으로 켜진다 — 지금 어디에 있는지를 말하는 자리다.
   *
   * 콜백이 아니라 선언인 이유는 반응성 때문이다. 호스트는 자기 표면 스토어를 구독하고 있으므로
   * 이 값이면 정확히 그 변화에 맞춰 다시 그린다.
   */
  readonly surfaceId?: string;
  /**
   * 아이콘을 눌러도 캔버스의 활성 Operation 을 풀지 않는다. 레일 도구를 누르면 기본으로 활성이 풀리지만(Map 밖의 누름),
   * 지금 보는 Operation 을 그대로 이어 여는 도구 — 활성 Operation 의 목표를 여는 목표 표면처럼 — 만 켠다.
   */
  readonly keepsOperationActive?: boolean;
  /**
   * 대화 중심 화면에서 Operation 대화의 오른쪽 패널은 도구 줄을 세우지 않는다. 이 값을 켠 도구만 거기서도 남아 대상의 글자 탭
   * (구성원 등) 오른쪽에 같은 문법의 글자 단추로 선다 — 지금 보는 대화에서 곧장 이어 가는 도구(목표)만 켠다.
   * Theater 를 연 패널과 기존 배치의 레일은 이 값을 읽지 않는다.
   */
  readonly conversationTab?: boolean;
  /**
   * 대화 중심 화면에서 Operation 대화의 오른쪽 패널 머리에 이 엔트리(`conversationTab`)가 한 낱말 단추 대신 펼칠 하위 탭과 그 앞의 도구.
   * 폰과 기존 배치의 레일은 이 값을 읽지 않는다.
   */
  readonly conversationTabs?: RailEntryConversationTabs;
  /**
   * 이 엔트리가 팔레트 검색 결과를 낼 수 있다면 그 공급자.
   *
   * 검색은 보통 페인에 붙는다 — 결과를 고르면 "어느 페인에 어떤 params로" 열지를 알아야 하고,
   * 그 답을 아는 것이 결과를 만든 페인이기 때문이다. 그런데 페인을 세우지 않고 확대 표면을
   * 여는 엔트리도 찾을 것을 갖는다. 그 경우 착지는 `surfaceId`가 말하므로, 검색만 여기 붙는다.
   */
  readonly search?: PaneSearchProvider;
  /**
   * 이 도구가 사람의 손을 기다리는 일의 수 — 호스트가 아이콘 모서리에 수 배지로 세운다. 표면이 닫혀 있어도 선다.
   * 무엇을 세는지는 플러그인이 정하되, 사람이 답해야 할 것(결정 요청처럼)만 센다. 진행 중이거나 읽지 않은 것은 배지가 아니다.
   */
  readonly attention?: RailEntryAttention;
  /**
   * 모바일 배치에서 이 도구가 서는 자리. 생략하면 홈 바로가기 줄 끝 「더보기」가 여는 「플러그인」 화면에 한 행으로 서고, 현행 도구 시트로 열린다.
   * 데스크톱 레일은 이 값을 읽지 않는다.
   */
  readonly mobile?: RailEntryMobile;
  /**
   * 이 entry가 여는 표면이 레일 패널·확대 표면이 아닐 때(activate 전용) 켜짐을 말하는 법.
   * 선언하면 그 표면이 서 있는 동안 아이콘이 펼친 패널과 같은 문법(아래 brass 선 +
   * aria-pressed)으로 켜진다. 선언하지 않은 entry의 동작은 바뀌지 않는다.
   */
  readonly active?: RailEntryActive;
  /**
   * 이 entry를 목록에 둘지 정하는 문서 단위 판정. 생략하면 둔다.
   * 문서당 정적인 사실(Desktop 셸 여부 등)만 가린다 — Theater·Operation 상태로
   * 가리면 도구모음 칸이 나타났다 사라져 근육 기억을 깨므로 쓰지 않는다.
   */
  readonly visible?: () => boolean;
}

/** 모바일 배치에서 레일 엔트리가 서는 자리. */
export interface RailEntryMobile {
  /**
   * 「플러그인」 화면 행의 보조 줄 설명(예: 「변경·히스토리」). 데스크톱 전용 행이면 호스트가 뒤에 「 — 데스크톱에서만」을 붙인다.
   * 생략하면 보조 줄은 필요한 말(데스크톱 전용 표시)만 선다.
   */
  readonly description?: LocalizedText;
  /**
   * 모바일 홈 바로가기 칩과 「플러그인」 화면 행에 쓸 아이콘(데스크톱 레일 아이콘과 다른 모양이 필요할 때). 24×24 격자에 선 1.7·둥근 끝이고
   * 색은 글자색(`currentColor`)을 따른다. 생략하면 엔트리의 `icon`을 쓴다.
   */
  readonly icon?: ReactNode | (() => ReactNode);
  /**
   * 폰에서 쓸 수 있는가. `false`면 모바일 「플러그인」 화면에 흐린 행(「데스크톱에서만」)으로 남고 눌러도 열리지 않는다 —
   * 쓸 수 없는 도구도 어디서 쓰는지 알 수 있게 목록에는 둔다. 생략하면 쓸 수 있다.
   */
  readonly available?: boolean;
  /**
   * `false`면 이 엔트리는 모바일 배치에서만 선다 — 데스크톱 우측 레일·팔레트의 패널 목록에는 오르지 않는다.
   * 데스크톱에 이미 다른 표면(사이드바 줄 등)으로 서 있는 기능을 폰의 목적지 화면으로만 더 올릴 때 쓴다.
   * 페인 등록과 `panes.open`은 그대로 동작한다. 생략하면 데스크톱 레일에도 선다.
   */
  readonly desktop?: false;
  /**
   * 폰의 대화 정보 화면에서 이 엔트리(`conversationTab: true`)의 탭 본문으로 세울 페인. 생략하면 폰 대화 정보 화면에 이 엔트리의 탭이 없다.
   * 호스트는 그 페인을 탭 본문에 params `{ operationId }`(정보 화면의 대화 주인 Operation)로 세우고 `mobileBar`는 싣지 않는다 —
   * 막대가 없다는 것이 「대화 정보 화면 안에 심겼다」는 신호이고, 동작은 페인이 본문 안에 스스로 그린다. 닫을 자리가 없으므로 `panes.close()`는 아무 일도 하지 않는다.
   *
   * 폰에서 이 엔트리로 가는 착지(데스크톱은 읽지 않는다):
   * - `rail.open(id, { operationId })` — 그 Operation 대화를 열고 정보 화면의 이 탭을 세운다. 그 대화에 탭이 서지 않거나(`shown`) Operation이 없으면 기존 `rail.open` 경로다.
   * - 이 엔트리의 확대 표면(`surfaceId`) 열기 — 지금 열린 대화의 이 탭으로 연다. 열린 대화가 없거나 탭이 서지 않는 대화면 기존 경로(도구 시트)다.
   * - `attention.items`의 행 — 호스트는 엔트리의 자리로 먼저 이동하지 않고 `open`을 부른다. 착지는 `open`이 위 둘로 정한다.
   */
  readonly conversationPane?: RailEntryConversationPane;
  /**
   * 폰 홈 「대화」 아래 기본 접힌 「끝남 N」 섹션에 올릴 이 엔트리의 끝난 일(예: 끝난 목표). 생략하면 올리지 않는다.
   * 끝난 일은 대화 행·사이드바 줄로 서지 않으므로 묶음 줄(`OperationCluster.row`)이 아니라 여기서 말한다 — 데스크톱은 읽지 않는다.
   * 호스트는 묶음 줄이 「완료」(`row.glyph === "done"`)인 대화와 뿌리 없는 완료 줄도 같은 섹션에 모으므로, 이 선언은 줄로 서지 않는 끝난 일만 올린다.
   */
  readonly finished?: RailEntryMobileFinished;
  /**
   * 홈의 바로가기 칩으로 올린다. 목적지는 도구 시트가 아니라 상단 막대 아래 **화면**으로 열리고,
   * 그 화면의 본문은 이 엔트리의 primary 페인이다 — 모바일 호스트가 페인 컨텍스트에 `mobileBar`를 싣는다.
   * 이름과 아이콘은 엔트리의 `title`·`icon`을 쓴다.
   *
   * `order`는 정렬 값이다 — 작은 쪽이 앞(왼쪽). 「보관함」 칩과 「더보기」는 항상 이 목적지들 뒤에 서고
   * 이 값은 플러그인 목적지끼리의 순서만 정한다. 같으면 등록 순서.
   */
  readonly destination?: {
    readonly order: number;
    /**
     * 이 목적지 칩을 지금 둘지. 상태(실험 기능 켜짐·활성 Theater)에 따라 줄이 서고 사라져야 할 때 쓴다 — 문서 단위의
     * `visible`은 정적이라 맞지 않다. 생략하면 늘 둔다. `get`이 false면 칩이 없고, 그 목적지를 보고 있던 중에
     * false가 되면 호스트가 홈으로 돌려보낸다. 호스트는 `useSyncExternalStore`로 읽으므로 `get`은 부작용 없이
     * 같은 상태에 같은 값을 돌려준다. 코어 호스트는 `theaterId`로 활성 Theater(없으면 null)를 건넨다.
     */
    readonly shown?: RailEntryDestinationShown;
    /**
     * 칩 오른쪽 끝 상태 칸 — 「꺼짐」·「판단 중」처럼 이 목적지가 가진 상태를 글리프와 낱말로 말한다. 생략하거나 `get`이 null이면 칸을 비운다.
     * 호스트는 값을 그대로 그리기만 하고 플러그인 상태를 읽지 않는다. 사람이 답할 일의 수는 이 칸이 아니라 `attention.count`다.
     */
    readonly trailing?: RailEntryDestinationTrailing;
    /**
     * 칩과 화면 제목에 쓸 짧은 이름(`title`과 같은 현지화 문자열 — 로케일 함수도 된다). 생략하면 엔트리의 `title`을 쓴다.
     * 데스크톱 레일 제목이 「Codex — 프로젝트 위키」처럼 길어도 모바일 칩에는 「위키」가 서게 한다.
     */
    readonly label?: LocalizedText;
    /**
     * `false`면 이 목적지는 홈 바로가기 칩·대표 자리에 서지 않는다 — 화면은 그대로 목적지로 열리지만(`rail.open`이 도구 시트가 아니라 이 화면을 세운다)
     * 입구는 플러그인이 정한 착지뿐이다. 목적지라 「더보기」의 「플러그인」 화면 행에도 서지 않는다. 생략하면 칩으로 선다.
     */
    readonly chip?: false;
  };
}

/** 폰 홈 「끝남」 섹션의 공급원 — `RailEntryMobile.finished`. */
export interface RailEntryMobileFinished {
  readonly subscribe: (listener: () => void) => () => void;
  /** 지금 Theater(엔트리 `scope`가 `fleet`이면 null)의 끝난 일, 보일 순서대로. 호스트는 값(id·제목·둘째 줄)으로 비교하므로 매번 새 배열을 돌려줘도 된다. */
  readonly items: (theaterId: string | null, locale: ConsoleLocale) => readonly RailEntryFinishedItem[];
}

/** 끝난 일 하나. 문자열은 모두 이미 현지화되어 있다. */
export interface RailEntryFinishedItem {
  /** 같은 엔트리 안에서 안정적인 키. */
  readonly id: string;
  readonly title: string;
  /** 둘째 줄의 상태 낱말 뒤에 붙는 사실(예: 「구성원 2 · 기준 3/3」). */
  readonly detail?: string;
  /** 행 아바타의 키가 될 Operation id — `OperationCluster.avatarOperationId`와 같은 뜻으로, 같은 사람을 그리는 다른 표면과 같은 얼굴이 선다. 생략하면 엔트리 아이콘이다. */
  readonly avatarOperationId?: string;
  /** 행을 눌렀을 때 — 착지는 이 함수가 정한다(호스트는 먼저 이동하지 않는다). */
  readonly open: () => void;
}

/** 폰 대화 정보 화면의 탭 본문 — `RailEntryMobile.conversationPane`. */
export interface RailEntryConversationPane {
  /** 탭 본문으로 세울 페인 id(이 플러그인이 등록한 페인). */
  readonly paneId: string;
  /**
   * 같은 페인의 여러 보기를 정보 옆 같은 탭 줄에 올린다. 생략하면 엔트리 이름의 탭 하나다.
   * 고른 보기와 본문은 플러그인이 함께 소유하고, 호스트는 select 뒤 같은 페인을 그린다.
   * operationId는 정보 화면의 대화 주인이다. 도구는 페인 본문에 둔다.
   */
  readonly tabs?: {
    readonly subscribe: (listener: () => void) => () => void;
    readonly read: (operationId: string) => RailEntryConversationTabsState;
    readonly select: (tabId: string, operationId: string) => void;
  };
  /**
   * 이 대화에 탭을 세울지. 생략하면 모든 대화에 선다. 호스트는 `useSyncExternalStore`로 읽으므로 `get`은 부작용 없이 같은 상태에 같은 값을
   * 돌려준다. `operationId`는 정보 화면의 대화 주인 Operation이다.
   */
  readonly shown?: {
    readonly subscribe: (listener: () => void) => () => void;
    readonly get: (operationId: string) => boolean;
  };
}

/** 모바일 바로가기 칩 오른쪽 끝 칸의 내용. 문자열은 이미 현지화되어 있다. */
export interface RailEntryDestinationTrailingValue {
  readonly text: string;
  /** 낱말의 톤 — 기본 `muted`, 꺼짐처럼 가라앉은 상태는 `faint`, 오류는 `danger`. */
  readonly tone?: "muted" | "faint" | "danger";
}

/** 모바일 바로가기 칩 오른쪽 칸의 공급원 — `RailEntryMobile.destination.trailing`. 호스트는 값(text·tone)으로 비교하므로 매번 새 객체를 돌려줘도 된다. */
export interface RailEntryDestinationTrailing {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: (theaterId: string | null) => RailEntryDestinationTrailingValue | null;
}

/** 모바일 바로가기 칩의 보임 공급원 — `RailEntryMobile.destination.shown`. */
export interface RailEntryDestinationShown {
  readonly subscribe: (listener: () => void) => () => void;
  /** 지금 이 목적지 행을 둘지. */
  readonly get: (theaterId: string | null) => boolean;
}

/**
 * 레일 아이콘 켜짐의 공급원. 호스트는 `useSyncExternalStore`로 읽으므로 `isActive`는
 * 부작용 없이 같은 상태에 같은 값을 돌려준다.
 */
export interface RailEntryActive {
  readonly subscribe: (listener: () => void) => () => void;
  /** 지금 이 entry의 표면이 서 있는가. */
  readonly isActive: () => boolean;
}

/** 패널 머리 줄의 하위 탭 하나. */
export interface RailEntryConversationTab {
  readonly id: string;
  readonly title: LocalizedText;
  /** 낱말 곁 점 — `attention` 은 사람이 답할 일, `unseen` 은 안 읽은 것. `label` 은 스크린 리더가 읽는다. */
  readonly dot?: { readonly tone: "attention" | "unseen"; readonly label: LocalizedText };
  /**
   * 이 탭이 대상의 「구성원」 탭을 대신한다 — 호스트는 자기 구성원 탭을 걷고, 그 탭이 켜져 있었으면 이 탭으로 옮긴다.
   * 한 머리에 「구성원」이 둘 서지 않게 한다.
   */
  readonly replacesMembers?: boolean;
}

/** 하위 탭 줄의 지금 모습. 호스트는 `useSyncExternalStore` 로 읽으므로 같은 상태에는 같은 객체를 돌려준다. */
export interface RailEntryConversationTabsState {
  readonly tabs: readonly RailEntryConversationTab[];
  /** 고른 보기의 탭 id. 켜짐 표시는 이 탭 줄을 보이는 호스트가 정한다. */
  readonly selected: string;
}

/**
 * 패널 머리 하위 탭의 공급원. 탭을 누르면 호스트가 `select` 를 부르고, 엔트리의 패널이 닫혀 있으면 엔트리를 연다(`activate` 가 있으면 그것).
 */
export interface RailEntryConversationTabs {
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: (theaterId: string | null) => RailEntryConversationTabsState;
  readonly select: (tabId: string, theaterId: string | null) => void;
  /**
   * 하위 탭 줄 위 한 줄(Theater 섹션 줄 자리)에 설 도구(예: 목표의 오늘·기한) — 하위 탭이 설 때만 그린다.
   * 모양과 접근성 묶음(role·aria-label)은 플러그인이 진다. 아무것도 그리지 않으면 줄도 남지 않는다.
   */
  readonly renderTools?: (ctx: { readonly theaterId: string | null; readonly language: ConsoleLocale }) => ReactNode;
}

/**
 * 레일 아이콘 배지의 공급원. 호스트는 `useSyncExternalStore`로 읽으므로 `count`는 부작용 없이 같은 상태에 같은 수를 돌려준다.
 * Theater는 호스트가 건넨다 — 엔트리 범위가 `theater`면 활성 Theater, 없으면 null이다.
 */
export interface RailEntryAttention {
  readonly subscribe: (listener: () => void) => () => void;
  /** 지금 기다리는 수. 0 이하면 배지를 거둔다. */
  readonly count: (theaterId: string | null) => number;
  /** 배지의 이름 — 아이콘 이름 뒤에 붙어 말풍선과 스크린 리더가 읽는다(예: "결정 요청 2"). */
  readonly label: (count: number, locale: ConsoleLocale) => string;
  /**
   * 기다리는 일 하나하나. 모바일 홈 맨 위 「확인 필요」 묶음이 대기 Operation과 함께 행으로 세운다.
   * `count`는 배지, 이 목록은 행이다 — 같은 일을 가리키는 것이 정상이다. 생략하면 배지만 서고 행은 오르지 않는다.
   * 갱신은 위 `subscribe`로 한다. `count`처럼 부작용 없이 같은 상태에 같은 값을 돌려주고,
   * 상태가 바뀌지 않았으면 **같은 배열 참조**를 돌려준다(`useSyncExternalStore` 스냅샷이다).
   */
  readonly items?: (theaterId: string | null, locale: ConsoleLocale) => readonly RailEntryAttentionItem[];
}

/** 사람의 손을 기다리는 일 하나. 문자열은 모두 이미 현지화되어 있다. */
export interface RailEntryAttentionItem {
  /** 같은 엔트리 안에서 안정적인 키 — 목록이 갱신돼도 행의 정체성이 된다. */
  readonly id: string;
  /** 이 엔트리를 등록한 플러그인이 선언한 `OperationCluster.id`(접두사 없음) — 모바일 목록은 그 묶음의 `row.mark`를 같은 맡김 스위치로 세운다. */
  readonly clusterId?: string;
  /** 행의 제목(예: 목표 이름). */
  readonly title: string;
  /** 행의 보조 줄(예: 「결정 요청 1건」). */
  readonly reason: string;
  /**
   * 행을 눌렀을 때. 호스트는 이 엔트리의 자리로 먼저 이동한 **뒤에** 부른다 — 단 엔트리가 `mobile.conversationPane`을 선언했으면 먼저 이동하지 않고,
   * 착지(그 대화의 탭 또는 목적지 화면)는 `open`이 정한다.
   */
  readonly open: () => void;
}
