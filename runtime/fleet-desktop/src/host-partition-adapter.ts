import type { Cookies, Session } from "electron";

import type { HostPartition } from "./host-transport.js";

/** 호스트 전용 파티션이 쓰는 Electron Session의 부분. 시험은 같은 모양의 가짜를 넣어 실제 어댑터 코드를 지난다. */
export type NativeHostSession = Pick<Session, "fetch" | "clearStorageData"> & { readonly cookies: Pick<Cookies, "get" | "set" | "remove"> };

export interface HostPartitionPins {
  pin(hostname: string, fingerprint: string): void;
  clear(): void;
}

/**
 * `HostPartition`을 Electron Session 위에 세운다. main이 `fleet-host-<hostKey>` 파티션과 그 인증서 핀으로 부른다.
 *
 * `clear`는 핀만 지우지 않는다. 같은 이름의 파티션은 다시 열어도 같은 Session이라, 쿠키·세션 저장소를 비우지 않으면
 * 옛 신뢰 대상의 자격이 새 신뢰 대상에 그대로 전송된다. 이 파티션은 호스트 하나의 것이므로 쿠키 저장소 전체를 비워도 범위가 넘치지 않는다.
 */
export function createHostPartitionAdapter(native: NativeHostSession, pins: HostPartitionPins): HostPartition {
  return {
    fetch: (url, init) => native.fetch(url, init),
    readCookies: async (url) => native.cookies.get({ url }),
    writeCookie: (cookie) => native.cookies.set(cookie),
    removeCookie: (url, name) => native.cookies.remove(url, name),
    pin: (hostname, fingerprint) => pins.pin(hostname, fingerprint),
    clear: async () => {
      pins.clear();
      await native.clearStorageData({ storages: ["cookies"] });
    },
  };
}
