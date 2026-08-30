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
 * 호스트가 프레임·페인 기하·포커스·주소를 전부 소유하고, 플러그인은 페인 하나의
 * 본문만 그린다. rail·floating과 같은 계약 형태이며 런타임 값을 싣지 않는다.
 *
 * **표면은 그릇이고 페인은 그 안의 열이다.** 레일 표면과 같은 어휘를 쓰는 것이 핵심이다 —
 * 같은 본문이 마운트만 바꿔 두 표면을 오갈 수 있는 이유가 그 어휘의 일치에 있다. 예전에는
 * 이 열을 '슬롯'이라 불렀고, 그래서 한 제품 안에 열을 가리키는 말이 둘이었다. 옛 이름은
 * `@deprecated`로 남아 있고 호스트가 둘 다 읽는다.
 *
 * 페인은 세로로 분할되고 개수 상한이 없다. 폭은 사용자가 분할선으로 조절하며,
 * 호스트가 가중치로 보관한다 — 플러그인은 자기 폭을 지시하지 못하고, 실제로 놓인
 * 폭은 `paneWidth`로 통보만 받는다(컨테이너 쿼리로 스스로 열화하라는 뜻이다).
 */
export interface ExpandedSurfaceDescriptor {
  /**
   * 콘솔 전체에서 유일해야 한다. 호스트는 접두를 붙이지 않고 이 값을 그대로 주소로 쓰며,
   * 먼저 등록된 표면이 이깁니다 — 같은 id를 든 뒤의 기여는 경고와 함께 버려진다.
   */
  readonly id: string;
  /**
   * 페인 머리에 설 이름. 표면 종류가 아니라 **지금 그 페인이 담은 것**을 말하므로
   * 항상 컨텍스트를 받는다 — 한 페인 안에서 문서를 갈아타면 제목도 따라간다.
   * 고정 이름은 `() => "Shell"`처럼 쓴다. (`LocalizedText`가 이미 함수형을 포함해
   * 유니온으로 두면 런타임에 두 함수를 구분할 수 없다.)
   */
  readonly title: (ctx: ExpandedSurfaceContext) => LocalizedText;
  readonly render: (ctx: ExpandedSurfaceContext) => ReactNode;
  /** 페인 머리 우측 도구 무리. 닫기 버튼은 호스트가 소유하므로 넣지 않는다. */
  readonly tools?: (ctx: ExpandedSurfaceContext) => ReactNode;
  /**
   * 이 페인이 닫혔다는 통보. 닫기 버튼·Esc·다른 표면의 요청 등 **호스트가 닫는 모든 경로**에서
   * 인스턴스가 목록에서 빠진 뒤 불린다.
   *
   * 닫기는 호스트가 소유하지만, "내가 확대되어 있다"를 함께 들고 있는 플러그인은 그 사실을
   * 되돌릴 기회가 필요하다 — 통보가 없으면 페인은 사라졌는데 플러그인은 여전히 확대 중이라
   * 믿어, 축소 화면도 페인도 없는 막다른 골목이 된다. 여기서 다시 닫기를 부르지 말 것.
   */
  readonly onClose?: (ctx: ExpandedSurfaceCloseContext) => void;
  /** 페인 안쪽 좌측 열(문서 목차 등). 폭은 호스트가 정한다. */
  readonly aside?: (ctx: ExpandedSurfaceContext) => ReactNode;
  /**
   * 페인이 이 폭보다 좁아지지 않도록 분할선 드래그를 막는다(px). 생략하면
   * 호스트 기본값을 쓴다. 상한은 없다 — 좁아지는 쪽만 막는다.
   */
  readonly minPaneWidth?: number;
  /** @deprecated `minPaneWidth`로 이름이 바뀌었다. 둘 다 있으면 새 이름이 이긴다. */
  readonly minSlotWidth?: number;
}

export interface ExpandedSurfaceContext {
  /** 서술자가 선언한 id 그대로. */
  readonly surfaceId: string;
  /** 같은 표면을 두 페인에 띄웠을 때 둘을 가르는 id. */
  readonly instanceId: string;
  /** 무엇을 열었는지 — 표면이 스스로 정의한 사전. */
  readonly params: Readonly<Record<string, string>>;
  readonly paneIndex: number;
  readonly paneCount: number;
  /** 실제로 놓인 페인 폭(px). 분할선 드래그·창 리사이즈에 따라 갱신된다. */
  readonly paneWidth: number;
  /** @deprecated `paneIndex`로 이름이 바뀌었다. 호스트가 같은 값을 함께 싣는다. */
  readonly slotIndex: number;
  /** @deprecated `paneCount`로 이름이 바뀌었다. 호스트가 같은 값을 함께 싣는다. */
  readonly slotCount: number;
  /** @deprecated `paneWidth`로 이름이 바뀌었다. 호스트가 같은 값을 함께 싣는다. */
  readonly slotWidth: number;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  /** 이 페인을 닫는다. */
  readonly close: () => void;
  /** 이 페인으로 포커스를 옮긴다. */
  readonly focus: () => void;
  /** 같은 페인에서 다른 문서로 갈아탄다(주소도 함께 바뀐다). */
  readonly replaceParams: (next: Readonly<Record<string, string>>) => void;
}

/**
 * 닫힘 통보가 싣는 것. 페인은 이미 사라졌으므로 기하·포커스는 말할 수 없고, 어느
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
   * - `"reuse"`(기본): 기존 페인의 params를 바꾸고 포커스만 옮긴다.
   * - `"split"`: 페인을 하나 더 연다.
   */
  readonly mode?: "reuse" | "split";
  /** 지정하면 그 자리에 끼워 넣는다. 생략하면 맨 오른쪽. */
  readonly paneIndex?: number;
  /** @deprecated `paneIndex`로 이름이 바뀌었다. 둘 다 있으면 새 이름이 이긴다. */
  readonly slotIndex?: number;
}
