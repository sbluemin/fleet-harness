import type { ClientTheaterInboxCapability, TheaterInboxSnapshot } from "../../shared/theater-inbox.js";

import { theaterInboxCapability } from "./store.js";

/**
 * Theater 기여(사이드바 줄·메뉴)가 받는 Theater Inbox — 그 기여를 낸 플러그인의 범위로 좁힌다. 플러그인은 자기 섹션을 로컬 id
 * (`theaterInboxSections` 에 적은 id)로 열고 읽는다. 정준 id(`<pluginId>:<id>`)의 접두는 호스트만 안다.
 * 다른 주인의 섹션은 정준 id 그대로 읽힌다.
 */
const scoped = new Map<string, ClientTheaterInboxCapability>();

export function scopedTheaterInbox(contributionId: string): ClientTheaterInboxCapability {
  // 레지스트리는 기여 id 를 `<pluginId>:<id>` 로 붙인다 — 그 앞부분이 이 기여의 플러그인이다.
  const separator = contributionId.indexOf(":");
  if (separator <= 0) return theaterInboxCapability;
  const prefix = contributionId.slice(0, separator + 1);
  const cached = scoped.get(prefix);
  if (cached) return cached;
  let seen: TheaterInboxSnapshot | null = null;
  let local: TheaterInboxSnapshot | null = null;
  const read = (): TheaterInboxSnapshot | null => {
    const snapshot = theaterInboxCapability.read();
    if (snapshot === seen) return local;
    seen = snapshot;
    local = snapshot && snapshot.address.sectionId.startsWith(prefix)
      ? { theaterId: snapshot.theaterId, address: { sectionId: snapshot.address.sectionId.slice(prefix.length), pageId: snapshot.address.pageId } }
      : snapshot;
    return local;
  };
  const capability: ClientTheaterInboxCapability = {
    open: (request) => theaterInboxCapability.open({ ...request, sectionId: `${prefix}${request.sectionId}` }),
    close: theaterInboxCapability.close,
    read,
    subscribe: theaterInboxCapability.subscribe,
  };
  scoped.set(prefix, capability);
  return capability;
}
