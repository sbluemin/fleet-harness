import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type {
  ClientApiCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
  ConsoleTheme,
} from "../plugin/types.js";

/**
 * 확대 표면(Expanded Surface) — 캔버스를 덮는 비모달 작업면이다.
 *
 * 호스트가 프레임·슬롯 기하·포커스·주소를 전부 소유하고, 플러그인은 슬롯 하나의
 * 본문만 그린다. rail·floating과 같은 계약 형태이며 런타임 값을 싣지 않는다.
 *
 * 표면은 세션 안에서 산다 — 새로고침으로 돌아오게 하려면 그 주소는 플러그인이 스스로
 * 소유한다(호스트는 표면을 위한 쿼리스트링 왕복을 제공하지 않는다).
 *
 * 슬롯은 세로로 분할되고 개수 상한이 없다. 폭은 사용자가 분할선으로 조절하며,
 * 호스트가 가중치로 보관한다 — 플러그인은 자기 폭을 지시하지 못하고, 실제로 놓인
 * 폭은 `slotWidth`로 통보만 받는다(컨테이너 쿼리로 스스로 열화하라는 뜻이다).
 */
export interface ExpandedSurfaceDescriptor {
  /**
   * 콘솔 전체에서 유일해야 한다. 호스트는 접두를 붙이지 않고 이 값을 그대로 주소로 쓰며,
   * 먼저 등록된 표면이 이깁니다 — 같은 id를 든 뒤의 기여는 경고와 함께 버려진다.
   */
  readonly id: string;
  /**
   * 슬롯 머리에 설 이름. 표면 종류가 아니라 **지금 그 슬롯이 담은 것**을 말하므로
   * 항상 컨텍스트를 받는다 — 한 슬롯 안에서 문서를 갈아타면 제목도 따라간다.
   * 고정 이름은 `() => "Shell"`처럼 쓴다. (`LocalizedText`가 이미 함수형을 포함해
   * 유니온으로 두면 런타임에 두 함수를 구분할 수 없다.)
   */
  readonly title: (ctx: ExpandedSurfaceContext) => LocalizedText;
  readonly icon?: ReactNode | (() => ReactNode);
  readonly render: (ctx: ExpandedSurfaceContext) => ReactNode;
  /** 슬롯 머리 우측 도구 무리. 닫기 버튼은 호스트가 소유하므로 넣지 않는다. */
  readonly tools?: (ctx: ExpandedSurfaceContext) => ReactNode;
  /**
   * 이 슬롯이 닫혔다는 통보. 닫기 버튼·Esc·다른 표면의 요청 등 **호스트가 닫는 모든 경로**에서
   * 인스턴스가 목록에서 빠진 뒤 불린다.
   *
   * 닫기는 호스트가 소유하지만, "내가 확대되어 있다"를 함께 들고 있는 플러그인은 그 사실을
   * 되돌릴 기회가 필요하다 — 통보가 없으면 슬롯은 사라졌는데 플러그인은 여전히 확대 중이라
   * 믿어, 축소 화면도 슬롯도 없는 막다른 골목이 된다. 여기서 다시 닫기를 부르지 말 것.
   */
  readonly onClose?: (ctx: ExpandedSurfaceCloseContext) => void;
  /** 슬롯 안쪽 좌측 열(문서 목차 등). 폭은 호스트가 정한다. */
  readonly aside?: (ctx: ExpandedSurfaceContext) => ReactNode;
  /**
   * 슬롯이 이 폭보다 좁아지지 않도록 분할선 드래그를 막는다(px). 생략하면
   * 호스트 기본값을 쓴다. 상한은 없다 — 좁아지는 쪽만 막는다.
   */
  readonly minSlotWidth?: number;
}

export interface ExpandedSurfaceContext {
  /** 서술자가 선언한 id 그대로. */
  readonly surfaceId: string;
  /** 같은 표면을 두 슬롯에 띄웠을 때 둘을 가르는 id. */
  readonly instanceId: string;
  /** 무엇을 열었는지 — 표면이 스스로 정의한 사전. */
  readonly params: Readonly<Record<string, string>>;
  readonly slotIndex: number;
  readonly slotCount: number;
  /** 실제로 놓인 슬롯 폭(px). 분할선 드래그·창 리사이즈에 따라 갱신된다. */
  readonly slotWidth: number;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  /** 이 슬롯을 닫는다. */
  readonly close: () => void;
  /** 이 슬롯으로 포커스를 옮긴다. */
  readonly focus: () => void;
  /** 같은 슬롯에서 다른 문서로 갈아탄다(주소도 함께 바뀐다). */
  readonly replaceParams: (next: Readonly<Record<string, string>>) => void;
}

/**
 * 닫힘 통보가 싣는 것. 슬롯은 이미 사라졌으므로 기하·포커스는 말할 수 없고, 어느
 * 인스턴스가 무엇을 담고 있었는지만 남는다.
 */
export interface ExpandedSurfaceCloseContext {
  readonly surfaceId: string;
  readonly instanceId: string;
  readonly params: Readonly<Record<string, string>>;
}

/** 호스트가 표면을 여는 요청. 플러그인은 `openExpandedSurface`로 이 값을 넘긴다. */
export interface ExpandedSurfaceOpenRequest {
  readonly surfaceId: string;
  readonly params?: Readonly<Record<string, string>>;
  /**
   * 같은 표면이 이미 열려 있을 때의 처리.
   * - `"reuse"`(기본): 기존 슬롯의 params를 바꾸고 포커스만 옮긴다.
   * - `"split"`: 슬롯을 하나 더 연다.
   */
  readonly mode?: "reuse" | "split";
  /** 지정하면 그 자리에 끼워 넣는다. 생략하면 맨 오른쪽. */
  readonly slotIndex?: number;
}
