import type { ObjectiveRuntimeHydration, ConsoleObjectiveSummary } from "../../execution/shared/client-contract.js";
/**
 * 확대 표면을 여닫는 능력. 슬롯 목록·기하·포커스는 호스트가 소유하므로 플러그인은
 * "이걸 열어 달라"고 요청할 뿐이고, 어느 슬롯에 어떤 폭으로 서는지는 결정하지 못한다.
 */
/**
 * 콘솔 상태 중 플러그인이 알아도 되는 몫.
 *
 * 스토어 전체를 넘기지 않는다 — 넘기면 플러그인이 코어의 내부 형태에 결합되고,
 * 그 형태를 바꿀 때마다 플러그인이 깨진다. Theater 목록과 활성 Theater는 플러그인이
 * 자기 데이터를 어느 프로젝트 기준으로 읽을지 정하는 데 필요한 최소값이다.
 */
export interface ClientConsoleStateCapability {
  getTheaters(): readonly ConsoleTheaterSummary[];
  /**
   * Objective 목록의 브라우저 DTO 몫 — 제목·Theater·종류·활동. 활동은 코어가 런타임 축에서 읽는
   * 값이며, 어느 플러그인이 그 축의 권위인지는 플러그인이 알 필요가 없다. transcript·경로는 없다.
   * 사이드바와 같은 목록이라 부모가 대표하는 구성원(`parentObjectiveId`)은 빠진다 — 구성원을 거느리는
   * 플러그인만 `{ nested: true }` 로 함께 읽는다.
   */
  getObjectiveRecords(options?: { readonly nested?: boolean }): readonly ConsoleObjectiveSummary[];
  /** @deprecated Mount는 없다. 지금 보는 대화의 Theater를 반환한다. getViewedTheaterId를 사용한다. */
  getActiveTheaterId(): string | null;
  /** 지금 화면에 보이는 대화 또는 모바일 목록의 Theater. 빈 칸은 null이다. */
  getViewedTheaterId?(): string | null;
  /** 마운트하지 않고 해당 Theater의 Inbox를 연다. */
  viewTheater?(theaterId: string): void;
  /** 캔버스에서 활성인 Objective — 사이드바 칩·묶음 줄이 하이라이트하는 바로 그 값. 없으면 null. */
  getActiveObjectiveId(): string | null;
  /**
   * 코어 이벤트 스트림의 연결 상태 — 바뀌면 `subscribe` 가 울린다. `live` 로 돌아온 전이는 서버가 다시 닿는다는 증거다.
   * 이미 읽은 데이터를 단절 뒤에 다시 읽을 신호는 `consoleEvents.onReconnect` 다.
   * 구버전 호스트에는 없을 수 있다(apiVersion 은 같다) — 없으면 `live` 로 다룬다.
   */
  getConnection?(): ConsoleConnectionState;
  /**
   * 런타임 축(활동·수명주기)을 지금 신뢰할 수 있는지 — 축의 권위자가 `runtime.setHydration` 으로 보고한 값을 읽기만 한다.
   * `pending`·`degraded` 동안 `getObjectiveRecords` 의 `activity` 는 관측이 아니라 폴백(유휴·종료)이므로, 그 값으로 판정을 내리지 않는다.
   * 바뀌면 `subscribe` 가 울린다. 구버전 호스트에는 없을 수 있다(apiVersion 은 같다) — 없으면 `ready` 로 다룬다.
   */
  getObjectiveRuntimeHydration?(): ObjectiveRuntimeHydration;
  /**
   * 사람이 사이드바에서 열지 않고 고르기만 한 Objective — 「더블클릭으로 열기」를 켰을 때의 한 번 클릭이다. 무대는 그대로이므로
   * 활성과 다르며, 활성과 같아지거나 열리는 순간 null 로 돌아간다. 문맥을 따라가는 표면은 `getSelectedObjectiveId() ??
   * getActiveObjectiveId()` 를 읽는다. 바뀌면 `subscribe` 가 알리고, 고를 때는 `onMapObjectiveSelected` 도 함께 온다.
   * 구버전 호스트에는 없을 수 있다(apiVersion 은 같다) — 없으면 고른 것이 없는 것(null)으로 다룬다.
   */
  getSelectedObjectiveId?(): string | null;
  /** @deprecated Mount는 없다. viewTheater와 같이 해당 Theater의 Inbox를 연다. */
  setActiveTheater(theaterId: string): void;
  subscribe(listener: () => void): () => void;
  /**
   * 지도(캔버스) 영역의 가로 인셋(px) — 왼쪽은 사이드바가, 오른쪽은 레일이 덮는 폭(띄움 간격 포함). 레일을 끄는 동안에도
   * 실시간으로 바뀐다. 화면 위에 따로 뜨는 플러그인 면(서랍 등)이 지도를 넘지 않게 제 폭을 정할 때 쓴다.
   * 구버전 호스트에는 없을 수 있다 — 없으면 창 전체를 지도로 다룬다.
   */
  getMapInsets?(): { readonly left: number; readonly right: number };
  /** `getMapInsets` 가 바뀔 때마다 — 사이드바 여닫기·폭 조절, 레일 열기·닫기·끌기. */
  subscribeMapInsets?(listener: () => void): () => void;
}


export type ConsoleConnectionState = "connecting" | "live" | "offline";


export interface ConsoleTheaterSummary {
  readonly id: string;
  /** 원래 Theater 이름 — 별칭이 있어도 바뀌지 않는다. */
  readonly label: string;
  /**
   * 연결된 사령관의 읽기 전용 요약. 별칭은 UUID의 속성이다. 사령관을 부르는 자리는 `commodore?.alias ?? label` 로
   * 이름을 정하고, 별칭이 있으면 원래 Theater 이름을 함께 둔다. 구버전 호스트는 싣지 않는다.
   */
  readonly commodore?: { readonly id: string; readonly alias?: string };
}

/** 조합이 주입하는 사령관 이름 편집. Workspace는 UUID 발급·저장 구현을 알지 않는다. */
export interface CommodoreAliasEditor {
  readonly clamp: (value: string) => string;
  readonly save: (theaterId: string, alias: string | null) => Promise<void>;
}
