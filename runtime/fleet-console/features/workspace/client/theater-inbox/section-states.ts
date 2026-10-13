import { useMemo, useRef, useSyncExternalStore } from "react";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ConsoleTheaterSummary } from "@fleet-console/sdk/plugin";
import type { TheaterInboxSectionDescriptor, TheaterInboxSectionState } from "@fleet-console/sdk/theater-inbox";

/** 호스트가 정준 id 를 붙인 섹션. 순서가 곧 목록 순서다(호스트의 「Theater 설정」이 맨 앞). */
export interface ResolvedTheaterInboxSection {
  readonly id: string;
  readonly descriptor: TheaterInboxSectionDescriptor;
}

/** 섹션마다 `read` 를 구독한다. 아무 섹션도 바뀌지 않았으면 같은 배열을 돌려준다(useSyncExternalStore). */
export function useSectionStates(sections: readonly ResolvedTheaterInboxSection[], theater: ConsoleTheaterSummary, language: ConsoleLocale): readonly TheaterInboxSectionState[] {
  const cache = useRef<readonly TheaterInboxSectionState[]>([]);
  const subscribe = useMemo(() => (listener: () => void) => {
    const offs = sections.map(({ descriptor }) => { try { return descriptor.subscribe(listener); } catch { return () => undefined; } });
    return () => { for (const off of offs) off(); };
  }, [sections]);
  const read = () => {
    const next = sections.map(({ descriptor }): TheaterInboxSectionState => {
      try { return descriptor.read(theater, language); } catch { return LOADING; }
    });
    const previous = cache.current;
    if (next.length === previous.length && next.every((state, index) => state === previous[index])) return previous;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore(subscribe, read, read);
}
const LOADING: TheaterInboxSectionState = { availability: "loading", scope: "" };
