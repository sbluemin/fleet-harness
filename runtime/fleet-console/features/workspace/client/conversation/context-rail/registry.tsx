import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";

import type { ContextRailScope, ContextRailSession } from "../../../shared/context-rail.js";

/**
 * 컨텍스트 레일의 데이터 제공자. 대화 칸의 범위(scope)를 보고 자기 것이면 세션 목록으로 `children`을 부르고, 아니면 아무것도 그리지
 * 않는다. 제공자는 훅을 쓰므로 함수가 아니라 컴포넌트다 — 세션 목록은 그 기능의 상태에서 나온다.
 */
export type ContextRailProvider = ComponentType<{
  readonly scope: ContextRailScope;
  readonly children: (sessions: readonly ContextRailSession[]) => ReactNode;
}>;

let providers: readonly ContextRailProvider[] = [];
const listeners = new Set<() => void>();

/** 제공자를 등록한다. 돌려준 함수로 거둔다. */
export function registerContextRailProvider(provider: ContextRailProvider): () => void {
  providers = [...providers, provider];
  for (const listener of listeners) listener();
  return () => {
    providers = providers.filter((candidate) => candidate !== provider);
    for (const listener of listeners) listener();
  };
}

export function useContextRailProviders(): readonly ContextRailProvider[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => providers,
    () => providers,
  );
}
