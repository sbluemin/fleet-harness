import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import { flattenGroupedOrder } from "../store.js";
import type { OperationGroup, OperationNode } from "../types.js";

export function commandBandRenameCommitTarget(capturedOperationId: string | null, activeOperationId: string | null): string | null {
  return capturedOperationId !== null && capturedOperationId === activeOperationId ? capturedOperationId : null;
}

// Operation 메뉴는 사이드바·Alt+←/→와 동일한 그룹 인식 순서를 미러한다. collapsedGroups는
// 넘기지 않는다 — 스위처 메뉴는 접힌 그룹의 Operation도 도달 가능해야 한다(순서만 미러, 가시성 미러 아님).
export function commandBandTheaterOperations(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[],
  activeTheaterId: string | null,
  operationOrder: readonly string[],
): readonly OperationNode[] {
  return flattenGroupedOrder(
    operations.filter((operation) => operation.theaterId === activeTheaterId),
    groups.filter((group) => group.theaterId === activeTheaterId),
    operationOrder,
  );
}

// Theater만 전환하면(setActiveTheater) activeOperationId가 남는다 — 브레드크럼은
// 활성 Theater 소속 Operation만 신뢰한다(표시 가드, state는 건드리지 않는다).
export function commandBandActiveOperation(
  operations: readonly OperationNode[],
  activeOperationId: string | null,
  activeTheaterId: string | null,
): OperationNode | null {
  if (activeOperationId === null || activeTheaterId === null) return null;
  const operation = operations.find((candidate) => candidate.id === activeOperationId) ?? null;
  return operation !== null && operation.theaterId === activeTheaterId ? operation : null;
}

// 실행 카탈로그가 선언한 모델 행을 `launch.model → 표시 이름` 색인으로 접는다.
// 표시 이름의 출처는 실행 메뉴·Quick Launch 칩과 같은 카탈로그 행 라벨이다 — 게이트웨이 행은
// models.json의 `name`(provider 접두를 벗긴 소재 이름), 네이티브 Claude 행은 Opus/Fable/Sonnet.
// 브라우저 코드는 core-ai-gateway를 끌어올 수 없어 카탈로그가 유일한 통로이고, 라벨을 Operation
// payload에 복제해 두면 카탈로그가 바뀐 뒤 옛 Operation이 스테일 문자열을 안고 남는다.
export function commandBandLaunchModelLabels(catalog: readonly OperationCatalogPlugin[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const plugin of catalog) {
    for (const kind of plugin.kinds) {
      for (const group of kind.variants ?? []) {
        for (const row of group.rows) {
          const model = row.launch.model;
          if (typeof model === "string" && model !== "" && !labels.has(model)) labels.set(model, row.label);
        }
      }
    }
  }
  return labels;
}

// 브레드크럼 속성 칩이 말할 한 줄. 어떤 모델 좌표로 띄웠는지가 payload에 남아 있고 카탈로그가
// 그 이름을 알면 모델 이름이 CLI 라벨을 대신한다 — "Claude (Gateway)"는 지금 무엇이 돌고 있는지
// 말해 주지 않는다. 좌표가 없거나(옛 payload) 카탈로그가 모르는 모델(꺼진 모델·개편된 id)일
// 때만 CLI 라벨로 물러난다.
export function commandBandOperationAttribute(
  payload: Record<string, unknown>,
  modelLabels: ReadonlyMap<string, string>,
): string | null {
  const session = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? payload.session as Record<string, unknown>
    : undefined;
  const launchModel = typeof session?.model === "string" ? session.model : null;
  const modelLabel = launchModel === null ? undefined : modelLabels.get(launchModel);
  if (modelLabel !== undefined && modelLabel !== "") return modelLabel;
  return session?.harness === "claude-code" ? "Claude Code" : null;
}

// Tab 등으로 포커스가 스위처 래퍼(트리거+메뉴) 밖으로 나가면 메뉴를 닫는다.
// relatedTarget null(창 블러·비포커서블 클릭)도 닫는다 — 바깥 pointerdown 경로와 멱등.
export function commandBandSwitcherFocusLeft(wrapper: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return !(relatedTarget instanceof Node && wrapper.contains(relatedTarget));
}

// 포털 없는 밴드 내 absolute 메뉴의 left(래퍼 좌표계)를 viewport gutter 안으로 clamp한다.
// 우측 초과를 먼저 안으로 끌어들이고, 좌측 하한(gutter)이 최종 우선한다.
export function commandBandMenuClampedLeft(
  desiredLeft: number,
  wrapperViewportLeft: number,
  menuWidth: number,
  viewportWidth: number,
  gutter = 12,
): number {
  const maxLeft = viewportWidth - gutter - menuWidth - wrapperViewportLeft;
  const minLeft = gutter - wrapperViewportLeft;
  return Math.max(minLeft, Math.min(desiredLeft, maxLeft));
}

// 맵 컨트롤 클러스터(.command-band-map-controls)는 절대 배치라 그리드가 그 폭을 모른다.
// 매직 오프셋 상수는 버튼이 늘 때마다 겹침으로 깨졌으므로(구 116px 사고) 실측 폭에서 계산한다.
// 좌우 여백 트랙은 반드시 같은 하한을 쓴다 — 값이 어긋나면 하한이 물리는 순간 중앙이 밀린다.
// mapControlsLead는 스테이지 원점에서 앵커까지의 거리다 — 펼침이면 앵커=사이드바 폭=스테이지
// 원점이라 0, 접힘이면 스테이지 원점이 0이라 도킹 앵커 그대로다. 하한은 스테이지 원점 기준으로
// 재야 접힌 상태에서도 겹치지 않는다.
const COMMAND_BAND_MAP_CONTROLS_INSET_PX = 8;
const COMMAND_BAND_CENTER_BREATHING_PX = 12;
const COMMAND_BAND_CENTER_GUTTER_FLOOR_PX = 44;
const COMMAND_BAND_CENTER_MIN_PX = 168;

// 접힘 앵커 — 사이드바가 접히면 맵 컨트롤의 정박 경계(사이드바 우측 경계선)가 사라지므로,
// 좌측 컨트롤군의 실측 콘텐츠 끝을 새 앵커로 쓴다(브레드크럼이 이미 쓰는 "정렬 앵커는 실제
// 스테이지 경계" 원칙의 클러스터 판). CSS가 앵커에 INSET(--space-2)을 더해 펼침 상태와 같은
// 단일 간격으로 클러스터를 잇는다. 미측정(0 이하)이면 사이드바 폭 앵커로 폴백해 첫 페인트가
// 기존 문법과 동일하게 남는다.
export function commandBandMapControlsAnchor(
  collapsed: boolean,
  sideBarWidth: number,
  leftContentEnd: number,
): number {
  if (!collapsed || leftContentEnd <= 0) return sideBarWidth;
  return leftContentEnd;
}

// Activity Rail의 고정 스트립 폭. 패널 폭은 포함하지 않는다 — PR #302가 밴드를 레일
// 크기 조절에서 떼어냈고, 여기서 예약하는 것은 접히지 않은 레일이 늘 차지하는 스트립뿐이다.
export const COMMAND_BAND_RAIL_STRIP_PX = 44;

export function commandBandCenterGutter(mapControlsLead: number, mapControlsWidth: number): number {
  if (mapControlsWidth <= 0) return COMMAND_BAND_CENTER_GUTTER_FLOOR_PX;
  return Math.max(
    COMMAND_BAND_CENTER_GUTTER_FLOOR_PX,
    mapControlsLead + COMMAND_BAND_MAP_CONTROLS_INSET_PX + mapControlsWidth + COMMAND_BAND_CENTER_BREATHING_PX,
  );
}

// 좌우 여백 트랙을 뺀 나머지가 최소 판독 폭에 못 미치면 브레드크럼을 접는다.
// 미측정(0 이하)은 보이는 쪽으로 판정한다 — 첫 페인트에서 깜빡이며 사라지지 않게 한다.
export function commandBandCenterFits(centerTrackWidth: number, gutter: number): boolean {
  if (centerTrackWidth <= 0) return true;
  return centerTrackWidth - gutter * 2 >= COMMAND_BAND_CENTER_MIN_PX;
}
