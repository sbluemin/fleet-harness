import type { GlobalSettingsState } from "../../../../core/client/src/integration/types.js";
import {
  getGlobalSettingsStoreState,
  setGlobalSettingsField,
  subscribe as subscribeGlobalSettings,
  type GlobalSettingsField,
} from "../../../settings/client/global-settings-store.js";

/**
 * commander-tab 상태(정렬·접힘)의 서버 동기화 — `commander-placement.ts`(#2282)와 같은 의미다.
 * 같은 origin의 localStorage는 첫 그리기 캐시로만 쓰고, 서버 값을 받으면 그 값이 이긴다.
 * 서버 키가 null이고 캐시가 기본값과 다르면 세션당 한 번 옮기고, 서버 값이 오기 전에 사람이
 * 먼저 골랐으면 그 선택을 앞세운다. 저장은 하나씩 순서대로 보내 마지막 의도를 보낸다.
 * 실패하면 서버의 마지막 값으로 되돌린다(서버 값을 받은 적 없으면 화면 값 유지, 자동 재전송 없음).
 */
export interface ServerSyncedValueOptions<T> {
  /** settings store 필드 — `"commanderSort"`나 `"commanderFolds"`. */
  readonly field: GlobalSettingsField;
  /** 서버 키가 없을 때·되돌릴 때의 값. */
  readonly defaultValue: T;
  /** 같은 origin의 첫 그리기용 캐시 읽기. */
  readonly readCache: () => T;
  /** 캐시 쓰기 — 저장하지 못하면 이번 화면에서만 기억한다. */
  readonly writeCache: (next: T) => void;
  /** 서버·저장값을 읽는다. 형태가 틀리면 null(키 없음과 같다)이다. */
  readonly parseServerValue: (value: unknown) => T | null;
  /** 값 비교는 필드 단위로 한다 — 참조가 아니라 내용이 같으면 같은 값이다. */
  readonly equal: (left: T, right: T) => boolean;
  /** 기본값인가 — 서버에 값이 없을 때 이 origin 캐시를 옮길지 가른다. */
  readonly isDefault: (value: T) => boolean;
}

export interface ServerSyncedValue<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

/** 서버가 마지막으로 확정해 준 값. loaded가 거짓이면 아직 받은 적 없다. 값 null은 키 없음이다. */
interface ServerSnapshot<T> {
  readonly loaded: boolean;
  readonly value: T | null;
}

export function createServerSyncedValue<T>(options: ServerSyncedValueOptions<T>): ServerSyncedValue<T> {
  const { field, defaultValue, readCache, writeCache, parseServerValue, equal, isDefault } = options;

  function readServer(): ServerSnapshot<T> {
    try {
      const state = getGlobalSettingsStoreState().state;
      if (state === null || state === undefined) return { loaded: false, value: null };
      return { loaded: true, value: parseServerValue(state[field]) };
    } catch {
      return { loaded: false, value: null };
    }
  }

  const initialServer = readServer();
  let current: T = initialServer.loaded && initialServer.value !== null ? initialServer.value : readCache();
  let serverSynced = initialServer.loaded;
  /** 세션당 1회 이관이 나갔는지. 서버에 값이 없던 때의 캐시 저장은 한 번뿐이다. */
  let migrated = false;
  /** 서버에 아직 확정되지 않은 최근 의도. 비행 중에만 선다. */
  let pending: T | null = null;
  let inflight = false;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function finishPersist(target: T, ok: boolean): void {
    inflight = false;
    if (pending !== null && !equal(pending, target)) {
      // 그 사이 새 의도가 들어왔다 — 성공 여부와 무관하게 그것을 보낸다(직렬화).
      persist();
      return;
    }
    pending = null;
    if (ok) return;
    // 실패하면 화면을 서버의 마지막 값으로 되돌린다 — 저장되지 않은 값을 보여 주지 않는다.
    // 자동 재전송은 하지 않는다(서버 장애 때 PUT 고리가 된다). 사람이 다시 고르면 일반 경로로 새 저장이 나간다.
    const server = readServer();
    if (!server.loaded) {
      // 서버 값을 한 번도 받은 적 없으면 되돌릴 값이 없다 — 화면 값을 유지한다.
      return;
    }
    const back = server.value ?? defaultValue;
    if (!equal(current, back)) {
      current = back;
      writeCache(back);
      emit();
    }
  }

  function persist(): void {
    if (inflight || pending === null) return;
    const target = pending;
    inflight = true;
    try {
      // field와 target의 짝은 이 값의 주인이 묶는다 — store 제네릭은 필드 리터럴에서만 좁혀진다.
      const result = setGlobalSettingsField(field, target as GlobalSettingsState[GlobalSettingsField]);
      result.then(
        (saved) => finishPersist(target, saved),
        () => finishPersist(target, false),
      );
    } catch {
      finishPersist(target, false);
    }
  }

  function syncFromServer(): void {
    const server = readServer();
    // 저장 중인 동안의 스토어 변화(낙관 반영·성공 확정·실패 되돌림)는 이 저장의 메아리다.
    // 여기서 pending을 걷으면 실패 되돌림이 화면 값을 덮어버리므로, 확정은 finishPersist가 맡는다.
    if (!server.loaded || inflight) return;
    if (!serverSynced) {
      serverSynced = true;
      if (pending !== null) {
        // 서버 값이 오기 전에 사람이 이미 골랐다 — 그 의도가 먼저다.
        if (server.value !== null && equal(server.value, pending)) pending = null;
        return;
      }
      if (server.value === null && !migrated && !isDefault(current)) {
        // 서버에 한 번도 저장된 적 없음 — 이 origin의 캐시를 1회 이관한다.
        migrated = true;
        pending = current;
        persist();
        return;
      }
    } else if (pending !== null) {
      if (server.value !== null && equal(server.value, pending)) pending = null;
      else return;
    }
    if (server.value !== null && !equal(server.value, current)) {
      // 서버가 값을 가진 뒤에는 캐시가 서버를 따른다.
      current = server.value;
      writeCache(server.value);
      emit();
    }
    // 서버 값이 null인 채(키 소실 등) 들어오면 화면 값을 유지한다.
  }

  try {
    subscribeGlobalSettings(syncFromServer);
  } catch {
    // 스토어 구독에 실패해도 캐시 값으로 동작한다.
  }

  return {
    /** 동기 읽기 — 서버 값을 받기 전·실패 시에는 같은 origin 캐시(기본값)를 돌려준다. */
    get(): T {
      return current;
    },
    set(next: T): void {
      if (equal(current, next)) return;
      current = next;
      writeCache(next);
      emit();
      pending = next;
      persist();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
