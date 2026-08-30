import { useSyncExternalStore } from "react";

import type { PaneCloseContext, PaneMount, PaneOpenRequest, PaneRole } from "@fleet-console/sdk/pane";

/**
 * 표면에 서 있는 페인 인스턴스들.
 *
 * primary 페인은 보통 여기 없다 — 엔트리가 열리면 그 엔트리의 primary가 자동으로 선다. 다만
 * primary가 `replaceParams`로 주소를 얻었거나 팔레트·딥링크가 착지 params를 먼저 심은 뒤에는
 * 그 주소만 기억하는 인스턴스가 선다. 표면은 이를 추가 열로 세지 않고 자동 primary에 합친다.
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
export function closePane(
  paneId: string,
  options: { readonly keepAlive?: boolean; readonly onClose?: (ctx: PaneCloseContext) => void } = {},
): void {
  const target = state.rail.find((instance) => instance.paneId === paneId);
  if (!target) return;

  const rail = options.keepAlive
    ? state.rail.map((instance) => (instance.paneId === paneId ? { ...instance, visible: false } : instance))
    : state.rail.filter((instance) => instance.paneId !== paneId);

  emit({
    rail,
    focusedPaneId: state.focusedPaneId === paneId ? null : state.focusedPaneId,
  });
  // 인스턴스가 정리된 **뒤에** 알린다 — 통보를 받은 쪽이 상태를 되돌리며 다시 스토어를 읽으므로,
  // 먼저 부르면 아직 서 있는 자기 자신을 보게 된다.
  options.onClose?.({ paneId, params: target.params });
}

/**
 * 엔트리를 갈아탈 때 그 표면의 페인들을 정리한다. `keepAlive`를 선언한 것만 주차된 채 남는다.
 *
 * 판단 근거로 서술자 색인을 받는 이유는, 남길지를 정하는 것이 새로 선 엔트리가 아니라 그
 * 페인 자신이기 때문이다. 새 엔트리의 목록으로 거르면 떠나는 쪽이 지키던 상태가 사라진다.
 *
 * **부르는 쪽이 엔트리가 실제로 바뀐 순간만 고르는 것이 전제다.** 마운트마다 부르면 방금
 * 복원한 열이 그 순간 주차되고, 그것을 다시 세울 주체가 없다 — 페인을 연 것은 사용자의 한
 * 번뿐인 동작이었기 때문이다(실측: 새로고침 뒤 읽던 문서 열이 주차된 채로 남았다).
 */
export function resetSurfacePanes(
  descriptors: ReadonlyMap<string, { readonly keepAlive?: boolean; readonly role?: string }>,
  arriving?: ReadonlySet<string>,
): void {
  // 들어오는 엔트리의 **primary**는 정리 대상이 아니다 — 팔레트·딥링크가 표면을 열기 직전에
  // 심어 둔 착지 params가 이 정리에 쓸려 나가면, 문을 연 손짓이 곧 그 착지를 지운다. primary는
  // 표면과 수명을 같이하므로 params가 닫힘을 건너 남는 것은 폭 기억과 같은 연속성이다.
  // detail은 면제하지 않는다: 닫힌 동안은 이 정리가 돌지 않아, 면제하면 keepAlive 없이 닫힌
  // detail이 재열림에서 옛 params째 되살아난다(닫기=언마운트 계약 위반).
  const exempt = (paneId: string) => arriving?.has(paneId) === true && descriptors.get(paneId)?.role === "primary";
  const rail = state.rail
    .filter((instance) => exempt(instance.paneId) || descriptors.get(instance.paneId)?.keepAlive === true)
    .map((instance) => (
      exempt(instance.paneId) || !instance.visible ? instance : { ...instance, visible: false }
    ));
  const unchanged = rail.length === state.rail.length
    && rail.every((instance, index) => instance === state.rail[index]);
  if (unchanged && state.focusedPaneId === null) return;
  emit({ rail, focusedPaneId: null });
}

/**
 * 같은 페인이 다른 대상으로 갈아탄다. **가시성은 건드리지 않는다.**
 *
 * 예전에는 `openPane`을 그대로 불렀는데, 그 경로는 존재하는 인스턴스를 `visible: true`로
 * 되살린다. 확대된 문서가 주소를 갱신할 때마다 레일에 주차돼 있던 같은 페인이 함께 튀어나와,
 * 한 페인의 두 사본이 서로 다른 주소를 들고 다투게 된다.
 */
export function replacePaneParams(
  paneId: string,
  params: Readonly<Record<string, string>>,
  role: PaneRole,
): void {
  const target = state.rail.find((instance) => instance.paneId === paneId);
  if (target) {
    if (sameParams(target.params, params)) return;
    emit({
      ...state,
      rail: state.rail.map((instance) => (instance.paneId === paneId ? { ...instance, params } : instance)),
    });
    return;
  }

  // missing target은 자동 primary 외에도 이미 닫힌 detail의 늦은 콜백에서 생긴다. 후자를
  // 되살리면 닫기 계약이 뒤집히므로, 호출한 서술자가 primary라고 말한 경로만 씨앗을 만든다.
  if (role !== "primary") return;

  // primary는 엔트리와 함께 자동으로 서서 평소 스토어 인스턴스가 없다. 그 본문이 자기 주소를
  // 갈아탈 때 무시하면(설정 섹션 칩이 대표 사례) ctx.params가 영원히 빈 값에 머문다. 주소를
  // 처음 얻는 순간에만 인스턴스를 심고, RailSurface가 이를 자동 primary의 params로 합친다.
  emit({
    rail: [...state.rail, {
      paneId,
      // RailSurface가 인스턴스 없는 자동 primary에 쓰던 값과 같아야 첫 주소 변경이 본문을
      // 재마운트하지 않는다. 설정 검색어처럼 섹션 밖의 primary-로컬 상태도 그대로 남아야 한다.
      instanceId: `pane-primary-${paneId}`,
      params,
      mount: "rail",
      visible: true,
    }],
    focusedPaneId: state.focusedPaneId,
  });
}

function sameParams(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
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
