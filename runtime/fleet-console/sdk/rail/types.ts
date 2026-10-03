import type { OpenFileRequest, OpenWikiEntryRequest, OpenResult } from "../navigation/index.js";
import type { PluginInstallContext } from "../plugin/types.js";
import type { PaneTarget } from "../pane/types.js";
import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
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
  /** rail 동작이 Operation 대신 확대 표면을 열 때 쓴다. */
  readonly surfaces?: ClientExpandedSurfacesCapability;
  /** 도킹할 수 있는 동작 엔트리가 자기 패널을 열고 닫을 때 쓰는 창구. */
  readonly rail?: ClientRailCapability;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
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
   * 작전구역을 다루고, `fleet`은 스킬·원장·사용 한도처럼 Console 전체에 걸친다. 레일은 두 범위를
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
}
