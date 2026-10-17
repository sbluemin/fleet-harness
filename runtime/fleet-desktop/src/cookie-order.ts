/**
 * 같은 origin+port에 쿠키를 싣는 요청(legacy join, inline pair·observe·activate)을 한 번에 하나씩 보낸다.
 *
 * 네이티브 `session.fetch`는 응답을 돌려주기 전에 `Set-Cookie`를 jar에 적용한다. 앞선 응답이 늦게 도착해 새 값을
 * 덮지 못하게 하려면 요청 시작부터 응답 적용·확정까지가 한 구간이어야 한다. 일반 HTTP·SSE·ws는 쿠키를 발행하지 않으므로
 * 이 순서를 쓰지 않는다.
 *
 * 이 객체가 가진 것은 보유 여부와 대기자뿐이다. token·쿠키 값·URL은 들고 있지 않다. main이 하나를 만들어 join 쪽(remote-bridge)과
 * inline 쪽(host-transport)에 같은 것을 명시 주입한다 — 둘이 따로 만들면 직렬화가 둘로 갈라져 아무것도 지키지 못한다.
 */
export interface CookieOrder {
  /**
   * 그 origin의 순서를 얻는다. 얻으면 해제 함수를, 신호가 이미 꺼졌거나 대기가 가득 찼거나 대기 중 취소되면 null이다.
   * null이면 호출자는 요청을 보내지 않는다. `alive`가 거짓이 된 대기자는 순서가 와도 건너뛴다.
   * 해제는 네이티브 fetch가 실제로 settle된 뒤에 부른다. abort 요청은 settle이 아니다.
   */
  hold(origin: string, signal: AbortSignal, alive?: () => boolean): Promise<(() => void) | null>;
  /**
   * 기다리지 않고 지금 가용할 때만 순서를 얻는다. 바쁘면 null이고 호출자는 그 쿠키 작업을 건너뛴다.
   * 열려 있는지 읽은 뒤 쓰는 검사-사용 간격이 생기지 않도록, 짧은 쿠키 읽기·쓰기는 이 권한을 쥔 채 settle까지 한다.
   * 순서 보유자는 같은 권한을 이미 갖고 있으므로 이것을 다시 부르지 않는다.
   */
  tryHold(origin: string): (() => void) | null;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly alive: () => boolean;
  detach(): void;
  resolve(release: (() => void) | null): void;
}

interface Lane {
  held: boolean;
  readonly waiters: Waiter[];
}

/** 보유자 하나가 제한 시간 안에 끝난다는 호출자 계약 위에서, 같은 origin을 가리키는 호스트 몇 개와 폴링이 겹쳐도 넘지 않는 크기다. */
export const MAX_COOKIE_ORDER_WAITERS = 8;

/** origin 문자열을 같은 origin+port의 키로 맞춘다. 읽을 수 없는 값은 null이다. */
function keyOf(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    return `${parsed.origin}\n${parsed.port === "" ? "443" : parsed.port}`;
  } catch {
    return null;
  }
}

export function createCookieOrder(): CookieOrder {
  const lanes = new Map<string, Lane>();

  const onceRelease = (key: string, lane: Lane): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      handOver(key, lane);
    };
  };

  const handOver = (key: string, lane: Lane): void => {
    lane.held = false;
    for (;;) {
      const next = lane.waiters.shift();
      if (!next) break;
      next.detach();
      if (next.signal.aborted || !next.alive()) { next.resolve(null); continue; }
      lane.held = true;
      next.resolve(onceRelease(key, lane));
      return;
    }
    if (lanes.get(key) === lane) lanes.delete(key);
  };

  return {
    hold(origin, signal, alive = () => true) {
      const key = keyOf(origin);
      if (key === null || signal.aborted || !alive()) return Promise.resolve(null);
      let lane = lanes.get(key);
      if (!lane) {
        lane = { held: false, waiters: [] };
        lanes.set(key, lane);
      }
      const mine = lane;
      if (!mine.held) {
        mine.held = true;
        return Promise.resolve(onceRelease(key, mine));
      }
      if (mine.waiters.length >= MAX_COOKIE_ORDER_WAITERS) return Promise.resolve(null);
      return new Promise((resolve) => {
        const onAbort = (): void => {
          const index = mine.waiters.indexOf(waiter);
          if (index >= 0) mine.waiters.splice(index, 1);
          resolve(null);
        };
        const waiter: Waiter = { signal, alive, detach: () => signal.removeEventListener("abort", onAbort), resolve };
        mine.waiters.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    tryHold(origin) {
      const key = keyOf(origin);
      if (key === null) return null;
      let lane = lanes.get(key);
      if (lane?.held) return null;
      if (!lane) {
        lane = { held: false, waiters: [] };
        lanes.set(key, lane);
      }
      lane.held = true;
      return onceRelease(key, lane);
    },
  };
}
