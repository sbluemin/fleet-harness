import { useSyncExternalStore } from "react";

import type { ExpandedSurfaceCloseContext, ExpandedSurfaceOpenRequest } from "@fleet-console/sdk/expanded-surface";

/**
 * 확대 표면 스토어 — 열린 슬롯의 순서 있는 목록과 폭 가중치를 소유한다.
 *
 * 캔버스 focus layer(canvas-store의 focusLayersByTheater)와 같은 급의 상태다:
 * 모듈 메모리에만 살고 durable state에 들어가지 않는다. 새로고침 뒤의 복원은
 * 영속이 아니라 URL 주소화가 책임진다 — 주소를 가진 표면만 돌아온다.
 *
 * 슬롯 개수에 상한이 없다. 좁아지는 것은 분할선 드래그의 최소폭 클램프가 막고,
 * 그 클램프는 픽셀을 아는 레이어가 적용한다(스토어는 가중치만 안다).
 */
export interface ExpandedSurfaceInstance {
  readonly instanceId: string;
  readonly surfaceId: string;
  readonly params: Readonly<Record<string, string>>;
  /** 슬롯 폭 가중치. 합이 얼마든 상관없고 레이어가 fr로 정규화한다. */
  readonly weight: number;
}

interface ExpandedSurfaceState {
  readonly instances: readonly ExpandedSurfaceInstance[];
  readonly focusedInstanceId: string | null;
}

type Listener = () => void;

const EMPTY: ExpandedSurfaceState = { instances: [], focusedInstanceId: null };

const listeners = new Set<Listener>();
let state: ExpandedSurfaceState = EMPTY;
let instanceSeq = 0;

/**
 * 닫힘 통보를 배달할 곳. 스토어는 서술자를 모르므로(레이어가 레지스트리에서 조회한다)
 * 호스트가 한 번 묶어 준다. 닫기 경로는 여럿인데 통보는 하나여야 하기 때문에, 레이어의
 * 렌더 주기가 아니라 스토어의 닫기 지점에서 부른다.
 */
type CloseNotifier = (ctx: ExpandedSurfaceCloseContext) => void;

let notifyClosed: CloseNotifier = () => undefined;

export function bindExpandedSurfaceCloseNotifier(notifier: CloseNotifier): void {
  notifyClosed = notifier;
}

function announceClosed(instances: readonly ExpandedSurfaceInstance[]): void {
  for (const instance of instances) {
    // 한 표면의 실패가 나머지 슬롯의 통보를 삼키지 않게 한다.
    try {
      notifyClosed({ surfaceId: instance.surfaceId, instanceId: instance.instanceId, params: instance.params });
    } catch (error) {
      console.error(`Expanded surface onClose failed: ${instance.surfaceId}`, error);
    }
  }
}

export function subscribeExpandedSurfaces(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getExpandedSurfaceState(): ExpandedSurfaceState {
  return state;
}

function setState(next: ExpandedSurfaceState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function nextInstanceId(surfaceId: string): string {
  instanceSeq += 1;
  return `${surfaceId}#${instanceSeq}`;
}

function sameParams(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * 표면을 연다.
 *
 * 기본은 `"reuse"`다 — 같은 표면이 이미 슬롯을 차지하고 있으면 새 슬롯을 만들지 않고
 * 그 슬롯의 문서만 갈아탄다. 문서를 옮길 때마다 슬롯이 늘어나면 사용자가 닫아야 할
 * 창만 쌓인다. 나란히 두고 비교하려는 의도는 `"split"`으로 명시해야 한다.
 */
export function openExpandedSurface(request: ExpandedSurfaceOpenRequest): string {
  const params = request.params ?? {};
  const mode = request.mode ?? "reuse";

  if (mode === "reuse") {
    const existing = state.instances.find((instance) => instance.surfaceId === request.surfaceId);
    if (existing) {
      const paramsChanged = !sameParams(existing.params, params);
      const focusChanged = state.focusedInstanceId !== existing.instanceId;
      // 이미 그 문서를 그 슬롯에서 보고 있으면 상태를 새로 만들지 않는다 — 새 객체를
      // 흘리면 아무것도 바뀌지 않았는데 모든 슬롯이 다시 그려진다.
      if (!paramsChanged && !focusChanged) return existing.instanceId;
      setState({
        instances: paramsChanged
          ? state.instances.map((instance) =>
              instance.instanceId === existing.instanceId ? { ...instance, params } : instance,
            )
          : state.instances,
        focusedInstanceId: existing.instanceId,
      });
      return existing.instanceId;
    }
  }

  const instanceId = nextInstanceId(request.surfaceId);
  // 새 슬롯은 현재 슬롯들의 평균 몫을 갖고 들어온다 — 사용자가 넓혀 둔 비율을
  // 신규 진입이 리셋하지 않도록.
  const weight = averageWeight(state.instances);
  const instance: ExpandedSurfaceInstance = {
    instanceId,
    surfaceId: request.surfaceId,
    params,
    weight,
  };

  const instances = [...state.instances];
  const at =
    request.slotIndex === undefined
      ? instances.length
      : Math.max(0, Math.min(instances.length, Math.trunc(request.slotIndex)));
  instances.splice(at, 0, instance);

  setState({ instances, focusedInstanceId: instanceId });
  return instanceId;
}

function averageWeight(instances: readonly ExpandedSurfaceInstance[]): number {
  if (instances.length === 0) return 1;
  const total = instances.reduce((sum, instance) => sum + instance.weight, 0);
  return total / instances.length;
}

export function closeExpandedSurface(instanceId: string): void {
  const index = state.instances.findIndex((instance) => instance.instanceId === instanceId);
  if (index === -1) return;
  const instances = state.instances.filter((instance) => instance.instanceId !== instanceId);

  let focusedInstanceId = state.focusedInstanceId;
  if (focusedInstanceId === instanceId) {
    // 닫은 자리를 이웃이 물려받는다 — 오른쪽 우선, 없으면 왼쪽.
    const heir = instances[index] ?? instances[index - 1] ?? null;
    focusedInstanceId = heir?.instanceId ?? null;
  }

  const closed = state.instances[index];
  setState({ instances, focusedInstanceId });
  // 상태를 먼저 확정하고 통보한다 — 통보를 받은 쪽이 스토어를 다시 읽어도 이미 닫힌 뒤다.
  if (closed) announceClosed([closed]);
}

export function closeExpandedSurfacesOf(surfaceId: string): void {
  const closed = state.instances.filter((instance) => instance.surfaceId === surfaceId);
  if (closed.length === 0) return;
  const instances = state.instances.filter((instance) => instance.surfaceId !== surfaceId);
  const stillOpen = instances.some((instance) => instance.instanceId === state.focusedInstanceId);
  setState({ instances, focusedInstanceId: stillOpen ? state.focusedInstanceId : instances[0]?.instanceId ?? null });
  announceClosed(closed);
}

export function closeAllExpandedSurfaces(): void {
  if (state.instances.length === 0) return;
  const closed = state.instances;
  setState(EMPTY);
  announceClosed(closed);
}

export function focusExpandedSurface(instanceId: string): void {
  if (state.focusedInstanceId === instanceId) return;
  if (!state.instances.some((instance) => instance.instanceId === instanceId)) return;
  setState({ ...state, focusedInstanceId: instanceId });
}

export function replaceExpandedSurfaceParams(
  instanceId: string,
  params: Readonly<Record<string, string>>,
): void {
  const target = state.instances.find((instance) => instance.instanceId === instanceId);
  if (!target || sameParams(target.params, params)) return;
  setState({
    ...state,
    instances: state.instances.map((instance) =>
      instance.instanceId === instanceId ? { ...instance, params } : instance,
    ),
  });
}

/**
 * 분할선 드래그의 착지점. 레이어가 픽셀을 재고 최소폭을 클램프한 뒤, 결과 가중치를
 * 통째로 넘긴다 — 스토어는 순서만 맞으면 값을 검증하지 않는다.
 */
export function setExpandedSurfaceWeights(weights: readonly number[]): void {
  if (weights.length !== state.instances.length) return;
  let changed = false;
  const instances = state.instances.map((instance, index) => {
    const weight = weights[index];
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) return instance;
    if (instance.weight === weight) return instance;
    changed = true;
    return { ...instance, weight };
  });
  if (!changed) return;
  setState({ ...state, instances });
}

/** 열려 있는 슬롯 중 focus 대상의 인덱스. 없으면 -1. */
export function focusedExpandedSurfaceIndex(): number {
  return state.instances.findIndex(
    (instance) => instance.instanceId === state.focusedInstanceId,
  );
}

export function focusExpandedSurfaceByIndex(index: number): void {
  const target = state.instances[index];
  if (!target) return;
  focusExpandedSurface(target.instanceId);
}

export function useExpandedSurfaces(): ExpandedSurfaceState {
  return useSyncExternalStore(
    subscribeExpandedSurfaces,
    getExpandedSurfaceState,
    getExpandedSurfaceState,
  );
}

/** 테스트 전용 — 모듈 싱글턴을 초기 상태로 되돌린다. */
export function resetExpandedSurfacesForTest(): void {
  state = EMPTY;
  instanceSeq = 0;
  listeners.clear();
  // 배달부도 함께 푼다 — 남겨 두면 앞 테스트의 표면이 뒤 테스트의 닫기를 받는다.
  notifyClosed = () => undefined;
}
