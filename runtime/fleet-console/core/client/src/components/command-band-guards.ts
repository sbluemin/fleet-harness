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

// 맵 컨트롤 클러스터는 좌측 클러스터(.command-band-left)의 플로우 형제로 합류했다(전면 해도
// 개편) — 사이드바-가장자리 추종 앵커는 캡 계약과 함께 퇴역했다. 중앙 브레드크럼의 좌우 여백
// 하한은 좌측 클러스터의 실측 콘텐츠 끝(모드 스위치·트레이 포함)에서 계산한다. 좌우 트랙은
// 반드시 같은 하한을 쓴다 — 한쪽만 예약하면 브레드크럼이 viewport 중앙에서 밀린다.
const COMMAND_BAND_CENTER_BREATHING_PX = 12;
const COMMAND_BAND_CENTER_GUTTER_FLOOR_PX = 44;
const COMMAND_BAND_CENTER_MIN_PX = 168;

export function commandBandCenterGutter(leftContentEnd: number): number {
  if (leftContentEnd <= 0) return COMMAND_BAND_CENTER_GUTTER_FLOOR_PX;
  return Math.max(
    COMMAND_BAND_CENTER_GUTTER_FLOOR_PX,
    leftContentEnd + COMMAND_BAND_CENTER_BREATHING_PX,
  );
}

// 좌우 여백 트랙을 뺀 나머지가 최소 판독 폭에 못 미치면 브레드크럼을 접는다.
// 미측정(0 이하)은 보이는 쪽으로 판정한다 — 첫 페인트에서 깜빡이며 사라지지 않게 한다.
export function commandBandCenterFits(centerTrackWidth: number, gutter: number): boolean {
  if (centerTrackWidth <= 0) return true;
  return centerTrackWidth - gutter * 2 >= COMMAND_BAND_CENTER_MIN_PX;
}
