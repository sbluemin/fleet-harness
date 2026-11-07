import { useEffect, useRef, useSyncExternalStore } from "react";

import type { SharedFolderList } from "../shared/shared-folder.js";
import type { Objective } from "../shared/types.js";
import { sharedListUrl } from "./shared-folder-url.js";

/**
 * 공유 폴더의 파일 수 — 우측 사이드바 펼침이 「라이브러리 탭에 보여 줄 것이 있는가」를 가를 때만 읽는다.
 * 목표 객체가 바뀌거나 행을 새로 가리킬 때 다시 읽고, 같은 객체의 진행 중 요청은 한 번만 나간다. 읽는 곳(행 글리프·목록·펼침 본문)이 이 캐시를 함께 쓴다.
 * 값이 null 이면 아직 모르거나 읽지 못한 것이다 — 비었다고 단정하지 않는다.
 */
type Entry = { readonly objective: Objective; readonly count: number | null };

const cache = new Map<string, Entry>();
const pending = new Map<string, Objective>();
const listeners = new Set<() => void>();
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function load(objective: Objective, fresh = false): void {
  const id = objective.id;
  if ((!fresh && cache.get(id)?.objective === objective) || pending.get(id) === objective) return;
  pending.set(id, objective);
  fetch(sharedListUrl(id))
    .then(async (response) => {
      if (!response.ok) throw new Error(`http_${response.status}`);
      return (await response.json()) as SharedFolderList;
    })
    .then((list) => ({ objective, count: list.entries.length }) as Entry, () => ({ objective, count: null }) as Entry)
    .then((entry) => {
      if (pending.get(id) !== objective) return;
      pending.delete(id);
      cache.set(id, entry);
      publish();
    });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;

/** objective 가 null 이거나 armed 가 아니면 읽지 않는다. 이미 읽은 값은 armed 와 무관하게 돌려준다(오래됐어도 다시 읽는 동안 유지). */
export function useSharedFileCount(objective: Objective | null, armed: boolean): number | null {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (armed && objective !== null) load(objective); }, [armed, objective]);
  // 파일은 보드 방송 없이도 늘어난다 — 행을 새로 가리키거나 펼칠 때마다 한 번 다시 읽는다.
  const latest = useRef(objective);
  latest.current = objective;
  useEffect(() => { if (armed && latest.current !== null) load(latest.current, true); }, [armed]);
  return objective === null ? null : cache.get(objective.id)?.count ?? null;
}
