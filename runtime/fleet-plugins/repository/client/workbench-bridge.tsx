import { useSyncExternalStore, type ReactNode } from "react";

/**
 * 작업면 열이 그릴 것 — 소스 트리 열이 알고 있는 것을 건네주는 다리.
 *
 * 저장소 패널의 상태는 하나다: 어느 체크아웃인지, 무엇을 보고 있는지, 원격 동사가 어디까지
 * 갔는지. 열을 둘로 갈랐다고 그 상태가 둘이 되지는 않는다. 그래서 소유자는 그대로 한쪽(트리
 * 열)에 두고, 다른 열은 그 결과를 **받아 그리기만** 한다.
 *
 * 상태를 통째로 스토어로 옮기지 않은 이유는 그것이 이 분할이 요구하는 일이 아니기 때문이다.
 * 여기서 갈라야 하는 것은 **화면의 두 자리**이고, 상태의 소유권은 이미 한 곳에 있어 옳다.
 * 옮겼다면 800줄의 얽힌 effect가 스토어 경유로 재배선되어, 분할과 무관한 위험을 함께 실었다.
 */

export interface RepositoryIdentity {
  readonly name: string;
  readonly branch: string | null;
  /** 하위 체크아웃(중첩 저장소·worktree)인가 — 캡션이 brass 표식으로 말한다. */
  readonly subcontext: boolean;
}

export type RepositoryVerb = "pull" | "push" | "stash";

export interface RepositoryVerbState {
  readonly syncing: boolean;
  readonly syncSettled: boolean;
  readonly syncFailed: boolean;
  /** "이미 최신 상태" 같은 한 줄 — 말풍선으로 뜬다. */
  readonly syncHint: string | null;
  readonly behind: number;
  readonly ahead: number;
  readonly disabled: boolean;
  readonly busy: RepositoryVerb | null;
  readonly outcome: { readonly verb: RepositoryVerb; readonly kind: "success" | "error"; readonly text: string } | null;
  readonly stashPromptOpen: boolean;
  readonly onSync: () => void;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onStash: () => void;
  readonly onStashSave: (message: string) => void;
  readonly onStashPromptClose: () => void;
}

export interface RepositoryWorkbench {
  readonly identity: RepositoryIdentity;
  readonly verbs: RepositoryVerbState;
  readonly body: ReactNode;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: RepositoryWorkbench | null = null;

export function publishRepositoryWorkbench(next: RepositoryWorkbench | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

export function useRepositoryWorkbench(): RepositoryWorkbench | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): RepositoryWorkbench | null {
  return current;
}
