import { useSyncExternalStore } from "react";

import type { PaneMount, PaneOpenRequest } from "@fleet-console/sdk/pane";

/**
 * 표면에 서 있는 페인 인스턴스들.
 *
 * primary 페인은 여기 없다 — 엔트리가 열리면 그 엔트리의 primary가 자동으로 서므로, 스토어가
 * 기억할 것은 **그 위에 추가로 열린 것들**뿐이다. 이 비대칭은 의도적이다: primary를 스토어에
 * 넣으면 "엔트리는 열렸는데 primary가 없는" 표현 가능한 잘못된 상태가 생긴다.
 *
 * keepAlive 페인은 닫혀도 목록에서 빠지지 않고 `visible: false`로 남는다. 그것이 PTY와 읽던
 * 자리를 지키는 방식이며, 지금 플러그인들이 portal parking·DOM relocate로 각자 하던 일이다.
 */

export interface PaneInstance {
  readonly paneId: string;
  readonly instanceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly mount: PaneMount;
  /** false면 살아 있되 보이지 않는다(keepAlive). 호스트가 `inert`로 격리한다. */
  readonly visible: boolean;
}

interface PaneStoreState {
  /** 레일 표면에 선 detail·aside 페인들. 순서가 곧 primary 오른쪽으로의 배치다. */
  readonly rail: readonly PaneInstance[];
  readonly focusedPaneId: string | null;
}

type Listener = () => void;

let state: PaneStoreState = { rail: [], focusedPaneId: null };
const listeners = new Set<Listener>();

// instanceId는 안정적이어야 한다 — 리렌더마다 새 값이면 React가 본문을 통째로 다시 마운트해
// keepAlive의 목적이 사라진다. 단조 증가 카운터면 충분하고, 시각에 의존하지 않아 테스트에서도
// 재현 가능하다.
let instanceSeq = 0;

function emit(next: PaneStoreState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribePaneStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPaneStoreSnapshot(): PaneStoreState {
  return state;
}

/**
 * 페인을 연다. 이미 서 있으면 params만 갈아 끼운다 — 같은 자리에서 문서를 갈아타는 것이
 * 새 열을 세우는 것보다 훨씬 흔하고, 그때 본문이 재마운트되면 스크롤과 포커스를 잃는다.
 */
export function openPane(request: PaneOpenRequest, options: { readonly keepAlive?: boolean } = {}): void {
  const mount = request.mount ?? "rail";
  if (mount !== "rail") return; // 확대 표면은 expanded-surface 스토어가 소유한다.

  const params = request.params ?? {};
  const existing = state.rail.find((instance) => instance.paneId === request.paneId);

  if (existing) {
    emit({
      rail: state.rail.map((instance) => (instance.paneId === request.paneId
        ? { ...instance, params, visible: true }
        : instance)),
      focusedPaneId: request.focus === false ? state.focusedPaneId : request.paneId,
    });
    return;
  }

  instanceSeq += 1;
  const instance: PaneInstance = {
    paneId: request.paneId,
    instanceId: `pane-${instanceSeq}`,
    params,
    mount,
    visible: true,
  };
  emit({
    rail: [...state.rail, instance],
    focusedPaneId: request.focus === false ? state.focusedPaneId : request.paneId,
  });
  void options;
}

/**
 * 페인을 닫는다. `keepAlive` 페인은 목록에 남되 보이지 않게 된다 — 본문이 살아 있어야 다음에
 * 열 때 읽던 자리로 돌아간다.
 */
export function closePane(paneId: string, options: { readonly keepAlive?: boolean } = {}): void {
  const target = state.rail.find((instance) => instance.paneId === paneId);
  if (!target) return;

  const rail = options.keepAlive
    ? state.rail.map((instance) => (instance.paneId === paneId ? { ...instance, visible: false } : instance))
    : state.rail.filter((instance) => instance.paneId !== paneId);

  emit({
    rail,
    focusedPaneId: state.focusedPaneId === paneId ? null : state.focusedPaneId,
  });
}

/**
 * 엔트리를 갈아탈 때 그 표면의 페인들을 정리한다. `keepAlive`를 선언한 것만 주차된 채 남는다.
 *
 * 판단 근거로 서술자 색인을 받는 이유는, 남길지를 정하는 것이 새로 선 엔트리가 아니라 그
 * 페인 자신이기 때문이다. 새 엔트리의 목록으로 거르면 떠나는 쪽이 지키던 상태가 사라진다.
 */
export function resetSurfacePanes(descriptors: ReadonlyMap<string, { readonly keepAlive?: boolean }>): void {
  const rail = state.rail
    .filter((instance) => descriptors.get(instance.paneId)?.keepAlive === true)
    .map((instance) => (instance.visible ? { ...instance, visible: false } : instance));
  const unchanged = rail.length === state.rail.length
    && rail.every((instance, index) => instance === state.rail[index]);
  if (unchanged && state.focusedPaneId === null) return;
  emit({ rail, focusedPaneId: null });
}

export function focusPane(paneId: string): void {
  if (state.focusedPaneId === paneId) return;
  emit({ ...state, focusedPaneId: paneId });
}

export function useRailPanes(): readonly PaneInstance[] {
  return useSyncExternalStore(subscribePaneStore, () => getPaneStoreSnapshot().rail, () => getPaneStoreSnapshot().rail);
}

export function useFocusedPaneId(): string | null {
  return useSyncExternalStore(
    subscribePaneStore,
    () => getPaneStoreSnapshot().focusedPaneId,
    () => getPaneStoreSnapshot().focusedPaneId,
  );
}

/** 테스트 전용 — 모듈 스코프 상태를 초기화한다. */
export function __resetPaneStoreForTests(): void {
  state = { rail: [], focusedPaneId: null };
  instanceSeq = 0;
}
