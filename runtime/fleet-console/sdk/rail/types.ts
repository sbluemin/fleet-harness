import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type { ClientApiCapability, ConsoleTheme } from "../plugin/types.js";
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

/**
 * 캔버스 면(Operation 캔버스 열 전체)을 잠시 빌려 쓰는 rail 기여의 본문 문맥.
 *
 * 확대는 플러그인이 스스로 여는 것이 아니다 — 캔버스는 호스트의 면이라, 기하·층·닫기·포커스
 * 반환은 호스트가 진다. 플러그인이 자기 판단으로 `.operations-canvas`를 찾아 portal하면 코어
 * DOM에 기대는 그림자 API가 태어난다. 그래서 이 문맥은 "지금 보이는가"와 "닫아 달라"만 준다.
 */
export interface RailCanvasSurfaceContext extends RailPanelContext {
  /** 이 면이 지금 화면에 서 있는가. 숨은 동안 무거운 일을 멈추는 판단에 쓴다. */
  readonly visible: boolean;
  /** 호스트에게 면을 접어 달라고 청한다. 실제로 접는 주체는 호스트다. */
  readonly close: () => void;
}

export interface RailCanvasSurfaceDescriptor {
  /** 면의 본문. 머리(제목·닫기)는 호스트가 그린다. */
  readonly render: (ctx: RailCanvasSurfaceContext) => ReactNode;
  /**
   * 머리 선반에 서는 이 면만의 동작. `@fleet-console/sdk/components/caption-actions`의 버튼을
   * 쓰면 호스트 창 컨트롤과 같은 문법으로 선다 — 같은 줄에 두 벌의 문법이 서지 않게.
   */
  readonly renderActions?: (ctx: RailCanvasSurfaceContext) => ReactNode;
}

interface RailContributionBase {
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon: ReactNode | (() => ReactNode);
  readonly side?: "right";
}

export type RailPanelDescriptor = RailContributionBase & ({
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly activate?: never;
  readonly canvasSurface?: never;
  readonly search?: RailSearchProvider;
  /** @deprecated Core ignores this field; every panel is Theater-root scoped. */
  readonly pathAware?: boolean;
  readonly defaultWidth?: number;
  readonly preferredExtraWidth?: number;
} | {
  /** 패널을 펼치는 대신 즉시 실행하는 rail 동작. */
  readonly activate: (ctx: RailPanelContext) => void;
  readonly render?: never;
  readonly canvasSurface?: never;
  readonly search?: never;
  readonly pathAware?: never;
  readonly defaultWidth?: never;
  readonly preferredExtraWidth?: never;
} | {
  /**
   * 레일에서 눌리면 좁은 패널 대신 캔버스 면을 빌려 서는 기여. 세 번째 갈래인 이유는 이것이
   * 세 번째 *종류*이기 때문이다 — 문맥 콜백 하나를 옵션으로 얹으면 "열어 달라"만 있고 그릴
   * 본문이 없는 상태가 표현 가능해진다.
   */
  readonly canvasSurface: RailCanvasSurfaceDescriptor;
  readonly render?: never;
  readonly activate?: never;
  readonly search?: never;
  readonly pathAware?: never;
  readonly defaultWidth?: never;
  readonly preferredExtraWidth?: never;
});
