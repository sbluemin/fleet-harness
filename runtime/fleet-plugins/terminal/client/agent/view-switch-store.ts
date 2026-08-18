import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 뷰 전환의 두 조각을 잇는 자리.
 *
 * 전환을 **누르는 곳**은 캡션 밴드이고, 그 결과를 **말하는 곳**은 본문이다 — 확인 오버레이도,
 * "열 수 없었다"는 문장도 대화가 흐르는 면에 서야 뜻이 통한다. 두 면은 서로 다른 React 트리에
 * 마운트되므로 상태를 props로 건널 수 없고, 그래서 이 작은 저장소가 사이에 선다.
 *
 * 호스트 번들과 나눠 갖는 상태가 아니라 이 플러그인 번들 안에서만 쓰는 값이다.
 */
export interface ViewSwitchState {
  /** 터미널 → 채팅 확인 오버레이가 열려 있는가. */
  readonly chatPromptOpen: boolean;
  /** 채팅 → 터미널 전환이 진행 중인가. */
  readonly terminalPending: boolean;
  /** 그 전환이 왜 안 됐는가 — 진행 중인 턴은 기다리면 풀리고, 그 밖의 실패는 아니다. */
  readonly terminalError: "none" | "busy" | "failed";
}

const IDLE: ViewSwitchState = { chatPromptOpen: false, terminalPending: false, terminalError: "none" };

const states = new Map<string, ViewSwitchState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function read(operationId: string): ViewSwitchState {
  return states.get(operationId) ?? IDLE;
}

function write(operationId: string, next: ViewSwitchState): void {
  const current = read(operationId);
  if (current.chatPromptOpen === next.chatPromptOpen
    && current.terminalPending === next.terminalPending
    && current.terminalError === next.terminalError) return;
  if (next.chatPromptOpen === IDLE.chatPromptOpen
    && next.terminalPending === IDLE.terminalPending
    && next.terminalError === IDLE.terminalError) states.delete(operationId);
  else states.set(operationId, next);
  emit();
}

export function useViewSwitchState(operationId: string): ViewSwitchState {
  return React.useSyncExternalStore(
    (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => read(operationId),
    () => read(operationId),
  );
}

export function setChatPromptOpen(operationId: string, open: boolean): void {
  write(operationId, { ...read(operationId), chatPromptOpen: open });
}

export function setTerminalHandoff(
  operationId: string,
  patch: { readonly pending?: boolean; readonly error?: ViewSwitchState["terminalError"] },
): void {
  const current = read(operationId);
  write(operationId, {
    ...current,
    ...(patch.pending === undefined ? {} : { terminalPending: patch.pending }),
    ...(patch.error === undefined ? {} : { terminalError: patch.error }),
  });
}

export function disposeViewSwitch(operationId: string): void {
  if (!states.delete(operationId)) return;
  emit();
}
