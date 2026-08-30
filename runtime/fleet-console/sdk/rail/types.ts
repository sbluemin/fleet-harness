import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type { ClientApiCapability, ClientExpandedSurfacesCapability, ConsoleTheme } from "../plugin/types.js";
import type { OperationLaunchKind } from "../operations/types.js";

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
  readonly launchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
  /** rail 동작이 Operation 대신 확대 표면을 열 때 쓴다. */
  readonly surfaces?: ClientExpandedSurfacesCapability;
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
  readonly activate: () => void | Promise<void>;
  /** "info"는 선택 불가 메타데이터 행 — 키보드 이동과 활성화에서 빠지고 읽기 전용으로 렌더된다. */
  readonly kind?: "info";
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
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon: ReactNode | (() => ReactNode);
  readonly side?: "right";
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
}
