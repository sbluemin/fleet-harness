import { createContext, useContext, useEffect, useMemo, useRef } from "react";

import type { ClientMobileBarCapability, MobileBarSpec } from "@fleet-console/sdk/pane";

import { pushBackLayer } from "./mobile-back.js";
import { claimMobileBar, releaseMobileBar, setMobilePluginDepth, type MobileBarState } from "./mobile-store.js";

/**
 * 모바일 목적지 화면이 페인에 건네는 상단 막대 창구. 컨텍스트로 두는 이유는 이 값이 있고 없음이 곧
 * 「호스트가 막대를 그려 준다」는 신호이기 때문이다 — 데스크톱 레일·확대 표면·도구 시트에는 공급자가 없어 페인 컨텍스트에 싣지 않는다.
 */
export const MobileBarContext = createContext<ClientMobileBarCapability | null>(null);

export function useMobileBarCapabilityValue(): ClientMobileBarCapability | null {
  return useContext(MobileBarContext);
}

/**
 * 플러그인 화면의 막대 어댑터. `set(spec)`을 호스트 막대 상태로 옮기고, 깊이를 history로 받친다:
 * 깊이가 오를 때 항목을 쌓고, ‹·시스템 뒤로는 모두 `history.back()` → popstate → 플러그인의 `onBack` 한 길로 모은다.
 * 플러그인이 스스로 깊이를 내리면(뒤로를 거치지 않고) 쌓아 둔 항목을 걷어 낸다.
 */
export function useMobilePluginBar(fallback: { readonly title: string }): ClientMobileBarCapability {
  const ownerRef = useRef<symbol>(Symbol("mobile-plugin-bar"));
  const specRef = useRef<MobileBarSpec | null>(null);
  const pushedRef = useRef(0);
  // 이 막대가 쌓은 항목의 표식(맨 위가 끝) — 다시 읽기 전에 쌓인 항목도 같은 깊이 숫자를 지니므로, 지금 막대의 항목인지는 이 표식으로 가린다.
  const entriesRef = useRef<string[]>([]);
  const instanceRef = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const entrySeqRef = useRef(0);
  const fromPopRef = useRef(false);
  const swallowRef = useRef(0);
  const layerRef = useRef<(() => void) | null>(null);
  const fallbackTitleRef = useRef(fallback.title);
  fallbackTitleRef.current = fallback.title;

  const publish = (spec: MobileBarSpec | null) => {
    const state: MobileBarState = spec === null
      ? { variant: "centered", title: fallbackTitleRef.current, leading: "menu" }
      : {
        variant: "centered",
        title: spec.title,
        ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
        leading: spec.depth > 0 ? "back" : "menu",
        ...(spec.depth > 0 ? { onBack: () => window.history.back() } : {}),
        ...(spec.actions && spec.actions.length > 0 ? { actions: spec.actions } : {}),
        ...(spec.menu && spec.menu.items.length > 0 ? { menu: { label: spec.menu.label ?? spec.title, ...(spec.menu.caption ? { caption: spec.menu.caption } : {}), items: spec.menu.items } } : {}),
      };
    claimMobileBar(ownerRef.current, state);
  };

  useEffect(() => {
    const owner = ownerRef.current;
    // 자식 페인의 effect가 이 effect보다 먼저 돈다 — 페인이 화면과 같은 커밋에 서면(rail.open을 먼저 부른 진입) 이미 선언한
    // 막대가 있다. 그때 기본 막대로 덮으면 보조 줄·⋮가 사라지므로, 선언된 것이 있으면 그것을 올린다.
    publish(specRef.current);
    const onPop = () => {
      if (swallowRef.current > 0) { swallowRef.current -= 1; return; }
      const spec = specRef.current;
      if (!spec || spec.depth <= 0 || pushedRef.current <= 0) return;
      // 이 막대의 맨 위 항목에 내려앉았다 — 그 위에 쌓인 다른 항목(좌표 시트 같은 오버레이)이 걷힌 것이지 상세를 떠난 뒤로가 아니다.
      // 그 오버레이는 자기 popstate를 스스로 닫거나 삼킨다(mobile-overlay-history). 여기서 onBack까지 부르면 상세가 함께 닫힌다.
      const landed = ((window.history.state as { fleetMobileBarEntry?: string } | null) ?? {}).fleetMobileBarEntry;
      if (landed !== undefined && landed === entriesRef.current.at(-1)) return;
      pushedRef.current -= 1;
      entriesRef.current.pop();
      setMobilePluginDepth(pushedRef.current);
      fromPopRef.current = true;
      spec.onBack?.();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      layerRef.current?.();
      layerRef.current = null;
      setMobilePluginDepth(0);
      releaseMobileBar(owner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo<ClientMobileBarCapability>(() => ({
    set(next) {
      const depth = Math.max(0, Math.floor(next.depth));
      const previous = specRef.current?.depth ?? 0;
      specRef.current = { ...next, depth };
      if (depth > previous) {
        for (let level = previous; level < depth; level += 1) {
          entrySeqRef.current += 1;
          const entry = `${instanceRef.current}:${entrySeqRef.current}`;
          window.history.pushState({ ...(window.history.state ?? {}), fleetMobileBarDepth: level + 1, fleetMobileBarEntry: entry }, "");
          pushedRef.current += 1;
          entriesRef.current.push(entry);
        }
      } else if (depth < previous && !fromPopRef.current && pushedRef.current > 0) {
        // 뒤로를 거치지 않고 플러그인이 스스로 올라왔다 — 쌓아 둔 항목을 걷는다. 그 popstate는 삼킨다.
        const surplus = Math.min(pushedRef.current, previous - depth);
        pushedRef.current -= surplus;
        entriesRef.current.splice(-surplus);
        swallowRef.current += 1;
        window.history.go(-surplus);
      }
      fromPopRef.current = false;
      setMobilePluginDepth(pushedRef.current);
      // 상세가 쌓여 있는 동안 하드웨어 뒤로는 그것을 하나 걷는다(브라우저 뒤로와 같은 history 한 칸).
      if (depth > 0 && layerRef.current === null) layerRef.current = pushBackLayer(() => window.history.back());
      if (depth === 0 && layerRef.current !== null) { layerRef.current(); layerRef.current = null; }
      publish(specRef.current);
    },
  }), []);
}

/**
 * 코어 화면이 자기 막대를 올리는 훅. 렌더마다 불러도 된다 — 내용이 같으면 막대를 다시 그리지 않고 동작 클로저만 갱신한다.
 * 화면이 내려가면 막대를 거둔다.
 */
export function useClaimMobileBar(state: MobileBarState): void {
  const ownerRef = useRef<symbol>(Symbol("mobile-screen-bar"));
  useEffect(() => { claimMobileBar(ownerRef.current, state); });
  useEffect(() => {
    const owner = ownerRef.current;
    return () => releaseMobileBar(owner);
  }, []);
}
