import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MongleActivity } from "../avatars/index.js";

/**
 * 아바타 활동 교체 시계 — 몽글 아바타와 스페셜 피규어(퀘이커)가 같은 규칙으로 활동을 바꾼다. 조형마다 다른 것은 활동별 반복 주기와
 * 손·소품(퇴장이 있는 층)·큰 동작이 있는 활동의 목록뿐이라 그것만 받는다. 큰 동작 예산은 문서 하나에 하나다 — 두 조형이 함께 센다.
 *
 * 패키지 밖으로 내보내지 않는 SDK 내부 모듈이다(`components/` 의 아바타 조형만 쓴다).
 */

export interface ActivityMotionConfig {
  /** 활동별 손·소품 반복 주기(ms, 배수 1 기준) — 그 조형 CSS 의 같은 활동 키프레임 주기와 짝이다. `default` 는 활동을 모를 때다. */
  readonly cycles: Readonly<Record<MongleActivity | "default", number>>;
  /** 손과 소품을 꺼내는 활동 — 바뀔 때 먼저 집어넣는다(퇴장). */
  readonly props: ReadonlySet<MongleActivity>;
  /** 큰 동작이 있는 활동. 큰 동작 층은 활동 주기의 두 배이고 앞 절반 안에서만 움직인다. */
  readonly big: ReadonlySet<MongleActivity>;
}

/** 크기 단계 — 같은 연기를 크기에 맞게 덜어 낸다. 단계 경계는 Console 에 실제로 있는 크기들 사이에 둔다. 몽글과 스페셜 피규어가 같은 문턱을 쓴다. */
export type AvatarTier = "full" | "mid" | "sil" | "mini";

export function avatarTier(size: number): AvatarTier {
  return size >= 48 ? "full" : size >= 22 ? "mid" : size >= 13 ? "sil" : "mini";
}

/** 한 활동에 머무는 최소 시간과 손·소품이 들어가는 시간(ms). */
const HOLD_MS = 1200;
const LEAVE_MS = 220;

/**
 * 큰 동작 예산 — 여러 아바타가 함께 보이는 크기(48px 미만)에서 큰 동작 층을 동시에 켤 수 있는 아바타 수. 넘치면 그 아바타는 손·소품만
 * 연기하고 줄을 선다. 자리를 잡은 아바타는 큰 동작을 두 번 이상 한 뒤, 기다리는 아바타가 있으면 휴식 구간에서 자리를 넘긴다.
 *
 * 문서 하나의 표시 예산이라 모듈 상태로 둔다. 번들마다 따로 셀 수 있지만 활동을 넘기는 것은 Console 한 곳뿐이다.
 */
const BIG_SLOTS = 4;
const BIG_LEASE_PERIODS = 2;
const bigHolders = new Set<object>();
const bigWaiting: { readonly owner: object; readonly grant: () => void }[] = [];

function requestBig(owner: object, grant: () => void): boolean {
  if (bigHolders.has(owner)) return true;
  if (bigHolders.size < BIG_SLOTS) {
    bigHolders.add(owner);
    return true;
  }
  if (!bigWaiting.some((entry) => entry.owner === owner)) bigWaiting.push({ owner, grant });
  return false;
}

function releaseBig(owner: object): void {
  const index = bigWaiting.findIndex((entry) => entry.owner === owner);
  if (index >= 0) bigWaiting.splice(index, 1);
  if (!bigHolders.delete(owner)) return;
  const next = bigWaiting.shift();
  if (!next) return;
  bigHolders.add(next.owner);
  next.grant();
}

export interface ActivityMotion {
  /** 지금 연기하는 활동. null 은 기본 리듬이다. */
  readonly activity: MongleActivity | null;
  /** 손과 소품을 집어넣는 중(교체 직전). */
  readonly leaving: boolean;
  /** 큰 동작 층이 켜졌다. */
  readonly big: boolean;
  /** 활동에 들어선 횟수 — 교체 경계의 기준 시각을 커밋 순간으로 옮길 때 짝을 맞춘다. */
  readonly entry: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * 활동 전환 규칙 하나를 아바타마다 돈다.
 *
 * - 작업 중으로 들어설 때는 바로 그 활동이다. 작업 중을 떠날 때도 바로다(상태 전환은 기다리지 않는다).
 * - 작업 중 안에서 활동이 바뀌면 지금 활동에 최소 1.2초 머문 뒤, 손과 소품을 넣고(0.22초) 그 반복의 경계에서 새 활동으로 바꾼다.
 *   퇴장은 경계 0.22초 앞에서 시작한다 — 교체 순간 몸 층이 휴식 자세(0%=100%)에 있어야 몸이 튀지 않는다.
 *   기다리는 동안 들어온 값은 마지막 하나만 남는다. 이 규칙이 짧은 도구 연타를 깜빡임 대신 한 동작으로 이어 준다.
 * - 경계 시각은 새 활동의 클래스가 커밋된 순간을 반복의 시작으로 보고 계산한다. 반복 키프레임은 0%=100%=휴식 자세라 한 프레임 어긋나도 튀지 않는다.
 */
class ActivityScheduler {
  private running = false;
  private target: MongleActivity | null = null;
  private tempo = 1;
  private budgeted = true;
  private shown: MongleActivity | null = null;
  private shownAt = 0;
  private leaving = false;
  private big = false;
  private bigSince = 0;
  private entry = 0;
  private swapTimer: ReturnType<typeof setTimeout> | null = null;
  private bigTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly owner = {};

  constructor(private readonly config: ActivityMotionConfig, private readonly publish: (motion: ActivityMotion) => void) {}

  update(running: boolean, target: MongleActivity | null, tempo: number, budgeted: boolean): void {
    if (this.disposed) return;
    const wasRunning = this.running;
    this.running = running;
    this.target = target;
    this.tempo = tempo;
    this.budgeted = budgeted;
    if (!running) {
      this.reset(null);
      return;
    }
    if (!wasRunning) {
      this.reset(target);
      return;
    }
    if (target === this.shown && !this.leaving) {
      this.clearSwap();
      return;
    }
    this.scheduleSwap();
  }

  /** 새 활동이 화면에 커밋된 순간 — CSS 반복이 실제로 시작한 시각에 가깝게 경계의 기준을 옮긴다. */
  committed(entry: number): void {
    if (entry === this.entry) this.shownAt = now();
  }

  dispose(): void {
    this.disposed = true;
    this.clearSwap();
    this.dropBig();
  }

  private cycle(): number {
    return this.config.cycles[this.shown ?? "default"] * this.tempo;
  }

  /** 지금 활동 반복의 다음 경계(최소 `after` ms 뒤). */
  private nextBoundary(after: number): number {
    const cycle = this.cycle();
    const elapsed = Math.max(after, now() - this.shownAt);
    return this.shownAt + Math.ceil(elapsed / cycle) * cycle;
  }

  private reset(activity: MongleActivity | null): void {
    this.clearSwap();
    this.dropBig();
    this.leaving = false;
    if (activity !== this.shown) this.entry += 1;
    this.shown = activity;
    this.shownAt = now();
    this.claimBig();
    this.emit();
  }

  private scheduleSwap(): void {
    if (this.swapTimer !== null) return;
    const props = this.shown !== null && this.config.props.has(this.shown);
    // 교체는 경계에 떨어지고, 손·소품이 있으면 퇴장은 그보다 0.22초 앞에서 시작한다.
    const at = this.nextBoundary(Math.max(HOLD_MS, now() - this.shownAt + (props ? LEAVE_MS : 0)));
    const leaveAt = props ? at - LEAVE_MS : at;
    this.swapTimer = setTimeout(() => this.beforeBoundary(at), Math.max(0, leaveAt - now()));
  }

  private beforeBoundary(at: number): void {
    this.swapTimer = null;
    if (this.target === this.shown) return;
    if (this.shown !== null && this.config.props.has(this.shown)) {
      this.leaving = true;
      this.emit();
      this.swapTimer = setTimeout(() => this.swap(), Math.max(0, at - now()));
      return;
    }
    this.swap();
  }

  private swap(): void {
    this.swapTimer = null;
    this.reset(this.target);
  }

  private clearSwap(): void {
    if (this.swapTimer !== null) clearTimeout(this.swapTimer);
    this.swapTimer = null;
  }

  /** 활동에 들어선 순간 큰 동작 자리를 청한다. 자리가 없으면 줄을 서고, 받으면 다음 반복 경계에서 켠다. */
  private claimBig(): void {
    if (this.shown === null || !this.config.big.has(this.shown)) return;
    if (!this.budgeted) {
      this.big = true;
      return;
    }
    if (requestBig(this.owner, () => this.granted())) this.startBig();
  }

  private startBig(): void {
    this.big = true;
    this.bigSince = now();
    this.armLease();
  }

  private granted(): void {
    if (this.disposed || this.shown === null || !this.config.big.has(this.shown)) {
      releaseBig(this.owner);
      return;
    }
    this.clearBigTimer();
    this.bigTimer = setTimeout(() => {
      this.bigTimer = null;
      // 교체가 걸려 있으면 켜지 않는다 — 곧 새 활동이 자리를 다시 청한다.
      if (this.leaving || this.swapTimer !== null) return;
      this.startBig();
      this.emit();
    }, Math.max(0, this.nextBoundary(0) - now()));
  }

  /** 큰 동작을 정해진 횟수만큼 한 뒤, 기다리는 아바타가 있으면 큰 동작 층의 휴식 구간 한가운데에서 자리를 넘긴다. */
  private armLease(): void {
    if (!this.budgeted) return;
    this.clearBigTimer();
    const cycle = this.cycle();
    const period = cycle * 2;
    const check = (index: number) => {
      const at = this.bigSince + index * period + cycle * 1.5;
      this.bigTimer = setTimeout(() => {
        this.bigTimer = null;
        if (bigWaiting.length === 0) {
          check(index + 1);
          return;
        }
        this.big = false;
        releaseBig(this.owner);
        this.emit();
      }, Math.max(0, at - now()));
    };
    check(BIG_LEASE_PERIODS - 1);
  }

  private clearBigTimer(): void {
    if (this.bigTimer !== null) clearTimeout(this.bigTimer);
    this.bigTimer = null;
  }

  private dropBig(): void {
    this.clearBigTimer();
    this.big = false;
    releaseBig(this.owner);
  }

  private emit(): void {
    if (this.disposed) return;
    this.publish({ activity: this.shown, leaving: this.leaving, big: this.big, entry: this.entry });
  }
}

export function useActivityMotion(config: ActivityMotionConfig, running: boolean, target: MongleActivity | null, tempo: number, budgeted: boolean): ActivityMotion {
  const [motion, setMotion] = useState<ActivityMotion>(() => ({ activity: running ? target : null, leaving: false, big: false, entry: running && target !== null ? 1 : 0 }));
  const scheduler = useRef<ActivityScheduler | null>(null);
  useEffect(() => {
    const created = new ActivityScheduler(config, (next) => setMotion((previous) =>
      previous.activity === next.activity && previous.leaving === next.leaving && previous.big === next.big && previous.entry === next.entry ? previous : next));
    scheduler.current = created;
    return () => {
      created.dispose();
      scheduler.current = null;
    };
  }, []);
  useEffect(() => {
    scheduler.current?.update(running, target, tempo, budgeted);
  }, [running, target, tempo, budgeted]);
  useLayoutEffect(() => {
    scheduler.current?.committed(motion.entry);
  }, [motion.entry]);
  return motion;
}
