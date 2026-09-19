/**
 * 원격 리스너의 무인증 문은 조인 하나뿐이고, 그 문은 인터넷을 향해 열려 있다.
 *
 * 자격 추측은 여기서 막을 대상이 아니다 — grant와 페어링 비밀은 256비트라 대입이 성립하지
 * 않는다. 이 예산이 막는 것은 그 뒤의 비용이다: 본문 읽기, grant 조회, 페어링 저장소 쓰기.
 * TLS 핸드셰이크는 이 계층보다 앞이므로 여기서 막지 못한다. 그 층의 폭주는 방화벽의 일이다.
 *
 * 두 축을 함께 쓴다. 출처별 예산은 한 곳에서 오는 반복 시도를 끊고, 전역 동시 상한은
 * 분산 폭주의 바닥을 받친다. 어느 쪽도 성공한 조인을 벌하지 않는다 — 계수되는 것은 실패뿐이고,
 * 성공은 그 출처의 예산을 되돌린다. 정상적으로 붙는 기기는 이 표에 흔적을 남기지 않는다.
 */

/** 한 출처가 창 안에서 실패할 수 있는 횟수. 정상 페어링은 실패하지 않으므로 넉넉할 이유가 없다. */
const DEFAULT_FAILURE_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;
/** 표의 크기를 고정한다 — 분산 시도가 이 표 자체를 메모리 공격면으로 바꾸지 못하게. */
const DEFAULT_SOURCE_SLOTS = 1024;
/** 동시에 처리 중인 무인증 조인의 상한. 정상 페어링이 걸리지 않도록 실패 예산보다 훨씬 느슨하다. */
const DEFAULT_CONCURRENCY = 8;

export type RemoteJoinVerdict = "ok" | "throttled" | "busy";
export type RemoteJoinOutcome = "paired" | "rejected";

export interface RemoteJoinStats {
  /**
   * 이 콘솔이 시작된 뒤 거절한 조인 수. 영속되지 않는다.
   *
   * 리스너를 껐다 켜도 예산과 계수는 유지한다 — 리스너 재시작으로 예산이 지워지면 그것이 곧
   * 예산을 비우는 방법이 되고, 주인이 그 초기화를 필요로 하는 흐름도 없다. 성공한 페어링이
   * 이미 그 출처의 예산을 지우므로 정상 기기가 갇히지도 않는다.
   */
  readonly count: number;
  readonly lastAt: number | null;
}

export interface RemoteJoinGuard {
  /** `ok`일 때만 진행하고, 진행했다면 반드시 `settle`로 닫는다. */
  readonly begin: (source: string) => RemoteJoinVerdict;
  readonly settle: (source: string, outcome: RemoteJoinOutcome) => void;
  readonly retryAfterSeconds: (source: string) => number;
  readonly stats: () => RemoteJoinStats;
}

export interface RemoteJoinGuardDeps {
  readonly now?: () => number;
  readonly failureLimit?: number;
  readonly windowMs?: number;
  readonly sourceSlots?: number;
  readonly concurrency?: number;
}

interface Bucket {
  failures: number;
  resetAt: number;
}

export function createRemoteJoinGuard(deps: RemoteJoinGuardDeps = {}): RemoteJoinGuard {
  const now = deps.now ?? (() => Date.now());
  const failureLimit = deps.failureLimit ?? DEFAULT_FAILURE_LIMIT;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const sourceSlots = deps.sourceSlots ?? DEFAULT_SOURCE_SLOTS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  // Map은 삽입 순서를 기억하므로 가장 오래된 항목부터 밀어낼 수 있다.
  const buckets = new Map<string, Bucket>();
  let inFlight = 0;
  let rejected = 0;
  let lastRejectedAt: number | null = null;

  /** 만료된 칸은 없는 것으로 본다 — 창이 지나면 실패는 잊힌다. */
  function liveBucket(source: string): Bucket | null {
    const bucket = buckets.get(source);
    if (bucket === undefined) return null;
    if (bucket.resetAt > now()) return bucket;
    buckets.delete(source);
    return null;
  }

  function openBucket(source: string): Bucket {
    const live = liveBucket(source);
    if (live !== null) return live;
    while (buckets.size >= sourceSlots) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) break;
      buckets.delete(oldest.value);
    }
    const fresh: Bucket = { failures: 0, resetAt: now() + windowMs };
    buckets.set(source, fresh);
    return fresh;
  }

  function countRejection(): void {
    rejected += 1;
    lastRejectedAt = now();
  }

  return {
    begin(source) {
      const bucket = liveBucket(source);
      if (bucket !== null && bucket.failures >= failureLimit) {
        countRejection();
        return "throttled";
      }
      if (inFlight >= concurrency) {
        countRejection();
        return "busy";
      }
      inFlight += 1;
      return "ok";
    },
    settle(source, outcome) {
      inFlight = Math.max(0, inFlight - 1);
      // 성공은 그 출처의 실패 기록을 지운다. 한 번 붙은 기기가 이웃의 소음 때문에 다음에 막히면 안 된다.
      if (outcome === "paired") {
        buckets.delete(source);
        return;
      }
      openBucket(source).failures += 1;
    },
    retryAfterSeconds(source) {
      const bucket = liveBucket(source);
      if (bucket === null) return Math.ceil(windowMs / 1000);
      return Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));
    },
    stats: () => ({ count: rejected, lastAt: lastRejectedAt }),
  };
}

/** IPv4-mapped IPv6는 같은 출처다 — 표기가 갈리면 예산이 두 배가 된다. */
export function normalizeRemoteJoinSource(address: string | undefined): string {
  if (address === undefined || address === "") return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return mapped === null ? address : mapped[1]!;
}
