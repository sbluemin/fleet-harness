import type { SidebarMotion } from "../shared/sidebar-remote.js";
/** 생산자의 상태 전환을 보관한다. 폴링 사이에 끝난 짧은 턴도 시작/끝이 각각 도착한다. */
export function createSidebarMotionJournal() {
  let revision = 0;
  const events: SidebarMotion[] = [];
  const last = new Map<string, string>();
  const listeners = new Set<() => void>();
  return {
    append(value: Omit<SidebarMotion, "revision" | "at">): void {
      const key = `${value.kind}:${value.id}`;
      // 도구 계열의 잦은 변화는 현재 스냅샷의 몫이다. 재생 큐는 턴·주의 전환만 남겨 짧은 턴을 밀어내지 않는다.
      const signature = JSON.stringify([value.live, value.state]);
      if (last.get(key) === signature) return;
      last.delete(key); last.set(key, signature);
      while (last.size > 4096) last.delete(last.keys().next().value!);
      events.push({ ...value, revision: ++revision, at: Date.now() });
      if (events.length > 1024) events.shift();
      for (const listener of [...listeners]) listener();
    },
    read(after: number) {
      return { revision, reset: after > revision || (events.length > 0 && after < events[0]!.revision - 1),
        motions: events.filter((event) => event.revision > after).slice(0, 128),
        next: events.filter((event) => event.revision > after).at(127)?.revision ?? revision };
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
