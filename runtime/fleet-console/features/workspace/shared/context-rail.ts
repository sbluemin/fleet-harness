import type { ReactNode } from "react";

/**
 * 대화 칸의 컨텍스트 창 계약. 레일은 컨텍스트 창 상세만 보여 주고, 세션이 어디서 오든(사령관 상주 세션, 지휘관·구성원 원장)
 * 같은 카드로 그린다. 데이터를 아는 기능이 제공자로 등록하고, 작업 영역은 채팅 위에 뜨는 칩만 맡는다.
 */

/** 문맥 창을 나눠 쓰는 한 덩어리. MCP 도구에는 `server`가, 스킬에는 vendor 출처 식별자 `source`와 플러그인 이름 `plugin`이 있다. */
export interface ContextRailRow {
  readonly name: string;
  readonly tokens: number;
  readonly server?: string;
  readonly source?: string;
  readonly plugin?: string;
}

/** 한 세션의 지금 문맥 창. 한 턴도 측정되지 않았으면 세션의 `measure`가 `null`이다(0%를 그리지 않는다). */
export interface ContextRailMeasure {
  /** 지금 창을 차지한 토큰. */
  readonly occupied: number;
  readonly max: number;
  /** 자동 압축을 위해 미리 비워 둔 자리. */
  readonly reserved?: number;
  /** 자동 압축이 걸리는 지점. 꺼져 있으면 없다. */
  readonly compactAt?: number;
  /** 범주별 내역. 비어 있으면(내역을 얻지 못한 세션) 카드는 총량만 그린다. */
  readonly slices: readonly ContextRailRow[];
  readonly memoryFiles: readonly ContextRailRow[];
  readonly mcpTools: readonly ContextRailRow[];
  /** 모델에게 알려 둔 스킬 목록(이름·설명)의 몫. Skill 도구로 연 본문은 대화 몫에 든다. */
  readonly skills: readonly ContextRailRow[];
  /** 턴이 시작됐고 아직 첫 값이 오지 않은 사이 — 옛 값이 새 사실인 척하지 않게 흐리게 그린다. */
  readonly stale?: boolean;
}

export interface ContextRailSession {
  /** 카드 열기·접기와 `/context`의 좌표. 같은 세션은 언제나 같은 id다. */
  readonly id: string;
  readonly name: string;
  readonly role: "commodore" | "commander" | "member";
  /**
   * 칩이 그리는 세션 얼굴. 제공자가 그 세션의 몽글 아바타를 넣는다 — 레일은 역할 글리프를 그리지 않는다.
   * 없으면 링 안은 빈 자리다.
   */
  readonly avatar?: ReactNode;
  readonly measure: ContextRailMeasure | null;
  /** 지금 대화 칸이 보는 세션 — 칩 줄에서 맨 위에 선다. */
  readonly focus: boolean;
  /** 자동 압축 안내 같은 세션 고유의 꼬리 문구 키가 필요하면 제공자가 준다. 없으면 공통 문구. */
  readonly footnote?: string;
}

export type ContextRailScope =
  | { readonly kind: "surface"; readonly surfaceId: string; readonly params: Readonly<Record<string, unknown>> }
  | { readonly kind: "objective"; readonly objectiveId: string; readonly bodyObjectiveId: string };
