import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MONGLE_BASES, type MongleActivity, type MongleRole } from "@fleet-console/sdk/avatars";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";
import { IDENTITY_TONES, isIdentityTone, type IdentityTone } from "@fleet-console/sdk/operations/identity-tones";

import "./new-session-playground.css";

/**
 * 새 세션 화면의 「몽글 놀이터」 — 「어디서」 카드 아래 바닥선에서 몽글이들이 걷고(산책로), 그네·시소·모래밭·미끄럼틀에서 논다(놀이기구).
 * 승인안(목표 b4f89230): A 산책로 + C 놀이기구를 한 무대에 두고, 누가 언제 어느 기구로 가서 놀지·걷기·멈춰 연기하기를 랜덤으로 고른다.
 * 출연진은 Theater 와 무관하게 몽글 베이스 15종 × 정체성 톤 8색이다. 이번 세션에 아직 안 나온 조합이 먼저 나오고,
 * 역할(안테나·구성원·별)은 등장할 때마다 랜덤이다. 등장은 걷기·미끄럼틀·모래밭·두리번 중 하나고, 인원은 약 70초 주기로
 * 2명과 폭 상한 사이를 오간다. 셋 중 하나꼴로 둘이 함께 들고 나며, 가끔은 미끄럼틀을 타고 나간다.
 *
 * - 배경 층이다: pointer-events 없음·aria-hidden. 카드와 컴포저 위로 오지 않고 클릭·포커스를 가져가지 않는다.
 * - 부르는 상태(대기·결정·검토의 발밑 빛, 안 본 답·오류·휴면 배지)는 놀이에 쓰지 않는다 — 쉼(idle)과 작업 중 연기(running+activity)만 쓴다.
 * - 「얼음」: 열(column)로 올라오는 input 이벤트만 듣는다(컴포저 코드는 건드리지 않음). 글이 있는 동안 멈춰 입력창 쪽을 보고, 1.6초 손을 떼면 다시 논다.
 * - 정지 장면: OS 움직임 줄이기·「아바타 차분하게」에서는 스케줄러 없이 소품 포즈로 선다. 숨은 창에서는 스케줄러가 쉰다.
 * - 연속: 무대와 그 DOM 은 이 모듈이 쥐고, Console 이 켜져 있는 동안 남는다. 화면을 떠나면 그 순간의 배우·탈것·
 *   애니메이션을 멈추고, 어떤 길로 돌아오든 그 순간부터 이어 재생한다. 닫혀 있던 시간만큼 장면을 앞당기지 않는다.
 *   입퇴장과 새 얼굴은 화면을 보고 있는 동안에만 일어난다. 같은 창을 새로고침하면 빈 무대에서 다시 시작한다.
 * - 몸을 좌우로 뒤집지 않는다(사령관 별은 왼쪽 위 고정) — 걷는 방향은 눈동자가 말한다.
 * - 높이가 모자라면 기구를 덜고 산책로만 남기며, 그마저 모자라면 층을 접는다. 폭이 좁으면 인원과 기구 수를 줄인다.
 */

/** 아바타 한 변 — 48px 이상이 연기 전체(full) 단계이고, 큰 동작 예산(48px 미만끼리 나눠 씀)을 사이드바와 다투지 않는다. */
const SIZE = 48;
/** 무대 띠 높이(띠 좌표) — 기구가 있는 띠와 산책로만 있는 띠. */
const BAND_FULL = 184;
const BAND_WALK = 86;
const MIN_SCALE = 0.62;
/** 바닥선이 띠 아래에서 떨어진 거리. */
const FLOOR = 12;
/** 무대 위 동시 인원 — 폭이 넓을 때. 좁으면 4·3명. 물결의 천장이다. */
const STAGE_CAP = 6;
/** 인원 목표가 조용(2명)과 상한 사이를 한 바퀴 도는 시간. */
const WAVE_PERIOD_MS = 70_000;
/** 연출이 인원을 목표에 맞추는 간격. */
const DIRECTOR_MS = 2_000;
/** 다시 들어온 직후 이 시간 동안은 새 등장을 열지 않는다. 떠나기 전에 예약된 등장이 곧장 새 얼굴을 들이지 않게 한다. */
const REENTRY_HOLD_MS = 3_000;
/** 미끄럼틀 등장 — 꼭대기에서 나타나 내려온다. CSS pg-slide-in 과 짝이다. */
const SLIDE_IN_MS = 2600;
const PEEK_MS = 1500;
const RISE_MS = 1600;
/** 역할 확률 — 지휘관 안테나 45%, 구성원 45%, 사령관 별 10%. */
const ROLE_COMMODORE = 0.1;
const ROLE_COMMANDER = 0.55;
const FREEZE_IDLE_MS = 1600;
const SWING_PERIOD_MS = 3000;
const SEESAW_PERIOD_MS = 3600;
const SLIDE_CLIMB_MS = 2700;
const SLIDE_TOTAL_MS = 5200;
/** 미끄럼틀 한 번에 몸이 옮겨 가는 가로 거리 — CSS pg-slide 의 끝 좌표와 짝이다. */
const SLIDE_RUN_X = 142;

type ItemKind = "swing" | "seesaw" | "sand" | "slide";
const ITEM_KINDS: readonly ItemKind[] = ["swing", "seesaw", "sand", "slide"];
const ITEM_WIDTH: Record<ItemKind, number> = { swing: 116, seesaw: 200, sand: 176, slide: 176 };
const ITEM_SEATS: Record<ItemKind, number> = { swing: 1, seesaw: 2, sand: 2, slide: 1 };
const SOLO_ACTS: readonly (readonly [MongleActivity, number])[] = [["read", 4800], ["think", 3200], ["edit", 3600], ["fetch", 3200]];
const SAND_ACTS: readonly MongleActivity[] = ["read", "edit", "think"];

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randInt = (lo: number, hi: number) => Math.floor(rand(lo, hi + 1));
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
function shuffle<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface CastMember {
  /** 등장마다 새 값 — 같은 얼굴이 나중에 다시 나와도 다른 배우다. */
  readonly id: string;
  readonly base: number;
  readonly tone: IdentityTone;
  readonly role: MongleRole;
  /** `${base}:${tone}` — 이번 세션에 본 얼굴과 지금 무대에 있는 얼굴을 가른다. */
  readonly key: string;
}

type Flourish = "slide-in" | "rise" | "peek";
type EntryStyle = "walk" | "peek" | "slide" | "sand";

function randomRole(): MongleRole {
  const r = Math.random();
  return r < ROLE_COMMODORE ? "commodore" : r < ROLE_COMMANDER ? "commander" : "member";
}

interface Seat { id: string | null; seated: boolean }
interface Item { readonly kind: ItemKind; cx: number; readonly seats: Seat[]; going: boolean }

type ActorMode = "out" | "walk" | "rest" | "act" | "chat" | "ride";
interface Ride { readonly item: number; readonly seat: number; readonly ox: number; readonly oy: number }
interface Actor {
  readonly cast: CastMember;
  present: boolean;
  enteredAt: number;
  mode: ActorMode;
  x: number;
  y: number;
  dur: number;
  look: -1 | 0 | 1;
  walking: boolean;
  running: boolean;
  act: MongleActivity | null;
  ride: Ride | null;
  slideRun: number;
  flourish: Flourish | null;
  /** 퇴장 중이면 연출이 다시 고르지 않고, 미끄럼틀이 끝나면 걸어 나간다. */
  exiting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
  task: (() => void) | null;
  remaining: number | null;
}

interface Layout {
  readonly width: number;
  readonly band: number;
  readonly scale: number;
  readonly withItems: boolean;
}

/**
 * 무대 스케줄러 — 배우·기구 모델을 쥐고 타이머로 다음 행동을 고른다. 위치는 배우 바깥 div 의 transform 전이(합성기)로 옮기고,
 * 기구의 반복 동작은 CSS 키프레임이 맡는다. 바뀔 때마다 `publish` 로 React 에 다시 그리라고 알린다.
 * 화면을 떠나면 `park` 가 타이머와 CSS 애니메이션을 그 순간에 멈추고, `resume` 이 남은 시간부터 다시 돌린다.
 */
class PlaygroundStage {
  actors: Actor[] = [];
  items: Item[] = [];
  layout: Layout | null = null;
  frozen = false;
  /** 입력으로 멈춰 입력창을 보는 중. 그리기는 이 값으로 눈동자를 내린다. */
  watching = false;
  private dynamic = true;
  /** 한 번이라도 장면을 세웠다. 이후 같은 폭에서는 배우·기구를 다시 만들지 않는다. */
  private booted = false;
  private structureKey = "";
  private entryTimer: ReturnType<typeof setTimeout> | null = null;
  private entryRemaining: number | null = null;
  private entryDeadline = 0;
  private disposed = false;
  private cap = STAGE_CAP;
  private deck: string[] = [];
  private readonly seen = new Set<string>();
  private serial = 0;
  /** 물결에 얹는 작은 흔들림. 연출이 가끔 ±1 로 바꾼다. */
  private jitter = 0;
  private directorTimer: ReturnType<typeof setTimeout> | null = null;
  private directorRemaining: number | null = null;
  private directorDeadline = 0;
  private directorResume: (() => void) | null = null;
  private companionTimer: ReturnType<typeof setTimeout> | null = null;
  private companionRemaining: number | null = null;
  private companionDeadline = 0;
  private companionResume: (() => void) | null = null;
  /** 새 세션 화면 밖에 무대를 치워 둔 상태. 닫혀 있던 시간은 장면에 더하지 않는다. */
  private held = false;
  /** 화면을 떠나 있던 시간의 합과, 지금 떠나 있다면 그 시각. */
  private awayMs = 0;
  private awaySince: number | null = null;
  /** `pause` 해 둔 CSS 애니메이션·전이와, 멈추기 직전의 currentTime. */
  private pausedAnimations: { animation: Animation; time: number }[] = [];
  /** 기구 순서는 마운트당 한 번만 정한다 — 다시 잴 때는 개수와 좌표만 새로 계산하고, 개수가 줄면 이 순서의 앞부분을 쓴다. */
  private readonly kindOrder = shuffle(ITEM_KINDS);

  constructor(private readonly publish: (sync?: boolean) => void, private readonly pinX: (id: string) => number | null) {}

  get ground(): number { return (this.layout?.band ?? BAND_FULL) - FLOOR; }
  private get standY(): number { return this.ground - SIZE; }
  private get maxX(): number { return (this.layout?.width ?? 0) - SIZE - 6; }

  /** 띠·기구 수·인원 상한·움직임 규칙. 배율은 빼서, 같은 폭으로 다시 열 때 장면을 다시 세우지 않는다. */
  private structureOf(layout: Layout | null, dynamic: boolean): string {
    if (!layout) return `none:${dynamic}`;
    const cap = layout.width < 520 ? 3 : layout.width < 820 ? 4 : STAGE_CAP;
    const itemCount = !layout.withItems ? 0 : layout.width >= 820 ? 4 : layout.width >= 470 ? 2 : layout.width >= 230 ? 1 : 0;
    return `${layout.band}:${itemCount}:${cap}:${dynamic}`;
  }

  /** 기구 좌표만 새 폭에 맞춘다. 좌석과 타고 있는 배우는 그대로다. */
  private placeItems(): void {
    const layout = this.layout;
    const count = this.items.length;
    if (!layout || count === 0) return;
    this.items.forEach((item, index) => {
      const cx = (layout.width * (index + 0.5)) / count;
      const shift = cx - item.cx;
      item.cx = cx;
      if (shift === 0) return;
      // 타고 있는 몽글이는 기구와 함께 옮긴다. 회전축(ox·oy)은 배우 기준이라 그대로 둔다.
      for (const actor of this.actors) {
        if (actor.ride?.item === index) actor.x += shift;
      }
    });
  }

  /**
   * 크기가 바뀌면 장면을 맞춘다. 이미 같은 구조로 서 있으면 배우·탈것·연출을 건드리지 않고 배율만 바꾼다.
   * 폭 칸이 달라질 때만 기구를 다시 만들고, 그때도 얼굴과 자리는 남긴 채 탈것만 푼다.
   */
  setup(layout: Layout | null, dynamic: boolean): void {
    this.disposed = false;
    const key = this.structureOf(layout, dynamic);
    if (this.booted && layout && key === this.structureKey) {
      const previous = this.layout;
      this.layout = layout;
      this.dynamic = dynamic;
      const scaleSame = previous !== null && previous.scale.toFixed(2) === layout.scale.toFixed(2) && Math.round(previous.width / 8) === Math.round(layout.width / 8);
      if (!scaleSame) {
        this.placeItems();
        this.publish();
      }
      return;
    }
    if (this.booted && layout && this.dynamic === dynamic) {
      this.retarget(layout, key);
      return;
    }
    this.clearTimers();
    this.layout = layout;
    this.dynamic = dynamic;
    this.frozen = false;
    if (!layout) {
      this.actors = [];
      this.items = [];
      this.booted = true;
      this.structureKey = key;
      this.publish();
      return;
    }
    this.cap = layout.width < 520 ? 3 : layout.width < 820 ? 4 : STAGE_CAP;
    const itemCount = !layout.withItems ? 0 : layout.width >= 820 ? 4 : layout.width >= 470 ? 2 : layout.width >= 230 ? 1 : 0;
    const kinds = this.kindOrder.slice(0, itemCount);
    this.items = kinds.map((kind, index) => ({
      kind,
      cx: (layout.width * (index + 0.5)) / itemCount,
      seats: Array.from({ length: ITEM_SEATS[kind] }, () => ({ id: null, seated: false })),
      going: false,
    }));
    this.actors = this.actors.filter((actor) => actor.present).slice(0, this.cap);
    for (const actor of this.actors) {
      Object.assign(actor, { mode: "rest", x: clamp(actor.x, 6, this.maxX), y: this.standY, dur: 0, look: 0, walking: false, running: false, act: null, ride: null, flourish: null, exiting: false, remaining: null });
    }
    this.booted = true;
    this.structureKey = key;
    if (!dynamic) {
      while (this.actors.length < this.cap) this.actors.push(this.cast());
      this.stillScene();
      this.publish();
      return;
    }
    for (const actor of this.actors) this.schedule(actor, rand(300, 1400), () => this.tick(actor));
    this.publish();
    this.direct();
  }

  /** 폭 칸이 바뀌었을 때의 최소 보정. 누구인지는 유지하고, 없어진 기구의 탈것만 푼다. */
  private retarget(layout: Layout, key: string): void {
    this.layout = layout;
    this.cap = layout.width < 520 ? 3 : layout.width < 820 ? 4 : STAGE_CAP;
    const itemCount = !layout.withItems ? 0 : layout.width >= 820 ? 4 : layout.width >= 470 ? 2 : layout.width >= 230 ? 1 : 0;
    const kinds = this.kindOrder.slice(0, itemCount);
    this.items = kinds.map((kind, index) => ({
      kind,
      cx: (layout.width * (index + 0.5)) / Math.max(1, itemCount),
      seats: Array.from({ length: ITEM_SEATS[kind] }, () => ({ id: null, seated: false })),
      going: false,
    }));
    for (const actor of this.actors) {
      // 옛 기구를 향한 예약(올라타기 등)은 새 기구 번호와 맞지 않는다. 버리고 처음부터 다시 고르게 한다.
      this.cancel(actor);
      actor.ride = null;
      actor.flourish = null;
      // 예약을 버렸으니 하던 일(타기·걷기·연기·대화)도 내려놓고 쉰다. 얼어 있던 무대는 녹을 때 쉬는 배우부터 다시 고른다.
      if (!actor.exiting) {
        actor.mode = "rest";
        actor.running = false;
        actor.act = null;
      }
      actor.walking = false;
      actor.x = clamp(actor.x, 6, this.maxX);
      actor.y = this.standY;
      actor.dur = 0;
    }
    this.structureKey = key;
    this.publish();
    // 빈 무대(null 레이아웃)에서 넘어온 경우에도 다시 돌게, 배우 예약과 연출을 새로 건다. 떠나 있거나 얼어 있으면 돌아올 때 건다.
    if (!this.dynamic || this.held || this.frozen) return;
    this.actors.forEach((actor, index) => {
      if (!actor.present) return;
      if (actor.exiting) this.walkOff(actor);
      else this.schedule(actor, 300 + index * 220, () => this.tick(actor));
    });
    this.direct();
  }

  /** 베이스 15종 × 정체성 톤 8색. 이번 세션에 안 나온 조합을 먼저 돌리고, 지금 무대에 있는 얼굴은 건너뛴다. */
  private cast(): Actor {
    const onStage = new Set(this.actors.map((actor) => actor.cast.key));
    const all = MONGLE_BASES.flatMap((base) => IDENTITY_TONES.map((tone) => `${base.id}:${tone}`));
    const open = (keys: readonly string[]) => keys.filter((key) => !onStage.has(key));
    if (this.deck.length === 0 || this.deck.every((key) => onStage.has(key))) {
      const fresh = open(all.filter((key) => !this.seen.has(key)));
      const pool = fresh.length >= 6 ? fresh : open(all);
      this.deck = shuffle(pool.length > 0 ? pool : all);
    }
    let index = this.deck.findIndex((key) => !onStage.has(key));
    if (index < 0) index = 0;
    const [picked] = this.deck.splice(index, 1);
    const [baseText, toneText] = (picked ?? "1:cerulean").split(":");
    const base = Number(baseText);
    const tone: IdentityTone = isIdentityTone(toneText) ? toneText : "cerulean";
    const key = `${base}:${tone}`;
    this.seen.add(key);
    this.serial += 1;
    return {
      cast: { id: `pg-${this.serial}`, base: Number.isFinite(base) ? base : 1, tone, role: randomRole(), key },
      present: true, enteredAt: performance.now(), mode: "rest", x: -SIZE - 12, y: this.standY, dur: 0, look: 0, walking: false, running: false, act: null,
      ride: null, slideRun: 0, flourish: null, exiting: false, timer: null, deadline: 0, task: null, remaining: null,
    };
  }

  /** 지금 무대에 서 있는 인원. 나가는 중인 배우는 빠진다. */
  private presentCount(): number {
    return this.actors.filter((actor) => actor.present && !actor.exiting).length;
  }

  /** 약 70초 주기로 2명과 폭 상한 사이를 오가는 목표 인원. */
  /** 장면 시계 — 화면을 떠나 있던 시간을 뺀다. 인원 물결은 이 시계를 따라, 다시 들어와도 떠날 때의 위상에서 이어 간다. */
  private sceneNow(): number {
    return performance.now() - this.awayMs;
  }

  private targetCount(): number {
    const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * this.sceneNow()) / WAVE_PERIOD_MS - Math.PI / 2);
    return clamp(Math.round(2 + 4 * wave + this.jitter), 2, this.cap);
  }

  /**
   * 인원 물결 — 목표보다 많으면 오래 머문 몽글이부터 내보내고, 적으면 들인다.
   * 셋 중 하나꼴로 둘이 같은 쪽에서 함께 오가며 서로를 본다.
   */
  private direct(): void {
    if (this.disposed || !this.dynamic || !this.layout || this.frozen) return;
    if (Math.random() < 0.15) this.jitter = pick([-1, 0, 0, 1] as const);
    const want = this.targetCount();
    const here = this.actors.filter((actor) => actor.present && !actor.exiting);
    if (here.length > want) {
      const free = here.filter((actor) => actor.ride === null && actor.mode !== "walk").sort((a, b) => a.enteredAt - b.enteredAt);
      const count = Math.min(here.length - want, Math.random() < 0.35 ? 2 : 1, free.length);
      const leavers = free.slice(0, count);
      if (leavers.length > 1) {
        const [first, second] = leavers;
        if (first && second) {
          first.look = second.x >= first.x ? 1 : -1;
          second.look = first.look === 1 ? -1 : 1;
          this.publish();
        }
      }
      leavers.forEach((actor, index) => {
        this.cancel(actor);
        this.schedule(actor, index * 380, () => this.leave(actor, leavers.length > 1));
      });
    } else if (here.length < want && this.entryTimer === null && this.entryRemaining === null) {
      const room = this.cap - here.length;
      const together = room >= 2 && want - here.length >= 2 && Math.random() < 0.35;
      const fromLeft = Math.random() < 0.5;
      this.armEntry(rand(700, 2400), () => {
        this.entryTimer = null;
        this.entryResume = null;
        if (this.disposed || this.frozen || this.presentCount() >= this.cap) return;
        this.enter(this.cast(), fromLeft, false);
        if (!together || this.companionTimer !== null) return;
        this.armCompanion(rand(450, 900), () => {
          this.companionTimer = null;
          this.companionResume = null;
          if (this.disposed || this.frozen || this.presentCount() >= this.cap) return;
          this.enter(this.cast(), fromLeft, true);
        });
      });
    }
    if (this.directorTimer === null && this.directorRemaining === null) {
      this.armDirector(DIRECTOR_MS, () => {
        this.directorTimer = null;
        this.directorResume = null;
        this.direct();
      });
    }
  }

  private armEntry(ms: number, fn: () => void): void {
    this.entryDeadline = performance.now() + ms;
    this.entryTimer = setTimeout(() => {
      this.entryTimer = null;
      this.entryRemaining = null;
      if (!this.disposed && !this.frozen) fn();
    }, ms);
    this.entryResume = fn;
  }
  private entryResume: (() => void) | null = null;

  private armDirector(ms: number, fn: () => void): void {
    this.directorDeadline = performance.now() + ms;
    this.directorTimer = setTimeout(() => {
      this.directorTimer = null;
      this.directorRemaining = null;
      if (!this.disposed && !this.frozen) fn();
    }, ms);
    this.directorResume = fn;
  }

  private armCompanion(ms: number, fn: () => void): void {
    this.companionDeadline = performance.now() + ms;
    this.companionTimer = setTimeout(() => {
      this.companionTimer = null;
      this.companionRemaining = null;
      if (!this.disposed && !this.frozen) fn();
    }, ms);
    this.companionResume = fn;
  }

  /** 미끄럼틀·모래밭이 없으면 걷기와 두리번만 쓴다. 같이 올 때는 걷기가 한 번 더 들어간다. */
  private entryStyle(companion: boolean): EntryStyle {
    const options: EntryStyle[] = ["walk", "peek"];
    if (this.items.some((item) => item.kind === "slide" && item.seats[0]!.id === null)) options.push("slide", "slide");
    if (this.items.some((item) => item.kind === "sand" && item.seats.some((seat) => seat.id === null))) options.push("sand", "sand");
    if (companion) options.unshift("walk");
    return pick(options);
  }

  private enter(actor: Actor, fromLeft = Math.random() < 0.5, companion = false): void {
    this.actors.push(actor);
    actor.enteredAt = performance.now();
    actor.exiting = false;
    const style = this.entryStyle(companion);
    if (style === "slide" && this.enterBySlide(actor)) return;
    if (style === "sand" && this.enterBySand(actor)) return;
    if (style === "peek") { this.enterByPeek(actor, fromLeft); return; }
    // 고른 기구가 그 사이에 찼으면 걷기로 들어온다. 다른 방식으로 바꾸지 않는다.
    if (style === "slide" || style === "sand") { this.enterByWalk(actor, fromLeft, companion); return; }
    this.enterByWalk(actor, fromLeft, companion);
  }

  /** 화면 밖 자리가 한 번 그려진 뒤 걸어 들어온다. 같이 온 둘은 닿으면 서로를 본다. */
  private enterByWalk(actor: Actor, fromLeft: boolean, companion: boolean): void {
    actor.mode = "walk";
    actor.flourish = null;
    actor.x = fromLeft ? -SIZE - 8 : (this.layout?.width ?? 0) + 8;
    actor.y = this.standY;
    actor.dur = 0;
    this.publish();
    this.schedule(actor, 80, () => {
      const target = fromLeft ? rand(10, Math.min(this.maxX, 260)) : rand(Math.max(10, this.maxX - 260), this.maxX);
      this.walkTo(actor, target, () => this.greetOrRest(actor, companion));
    });
  }

  private greetOrRest(actor: Actor, companion: boolean): void {
    if (!companion) { this.rest(actor, rand(300, 900)); return; }
    const buddy = this.actors.find((other) => other !== actor && other.present && !other.exiting && other.mode === "rest" && Math.abs(other.x - actor.x) < 160);
    if (!buddy) { this.rest(actor, rand(300, 900)); return; }
    this.cancel(buddy);
    actor.look = buddy.x >= actor.x ? 1 : -1;
    buddy.look = actor.look === 1 ? -1 : 1;
    actor.mode = "chat";
    buddy.mode = "chat";
    actor.running = true;
    buddy.running = true;
    actor.act = "text";
    buddy.act = "delegate";
    this.publish();
    this.schedule(actor, 2400, () => this.rest(actor, 600));
    this.schedule(buddy, 2400, () => this.rest(buddy, 600));
  }

  /** 꼭대기에서 나타나 미끄럼틀을 타고 내려온다. 자리가 없으면 걷기로 넘긴다. */
  private enterBySlide(actor: Actor): boolean {
    const index = this.items.findIndex((item) => item.kind === "slide" && item.seats[0]!.id === null);
    if (index < 0) return false;
    const item = this.items[index]!;
    item.seats[0] = { id: actor.cast.id, seated: true };
    actor.mode = "ride";
    actor.x = item.cx - ITEM_WIDTH.slide / 2 + 20 - SIZE / 2;
    actor.y = this.standY;
    actor.dur = 0;
    actor.running = true;
    actor.act = "run";
    actor.flourish = "slide-in";
    actor.slideRun += 1;
    actor.ride = null;
    this.publish();
    this.schedule(actor, SLIDE_IN_MS, () => {
      actor.flourish = null;
      actor.dur = 0;
      actor.running = false;
      actor.act = null;
      actor.x += SLIDE_RUN_X;
      item.seats[0] = { id: null, seated: false };
      this.rest(actor, rand(400, 900));
    });
    return true;
  }

  /** 모래에 반쯤 잠긴 자리에서 쏙 올라온 뒤 옆으로 걸어 나온다. */
  private enterBySand(actor: Actor): boolean {
    const index = this.items.findIndex((item) => item.kind === "sand" && item.seats.some((seat) => seat.id === null));
    if (index < 0) return false;
    const item = this.items[index]!;
    const seat = item.seats.findIndex((candidate) => candidate.id === null);
    item.seats[seat] = { id: actor.cast.id, seated: true };
    actor.mode = "ride";
    actor.x = this.seatX(item, seat);
    actor.y = this.ground - SIZE + 7;
    actor.dur = 0;
    actor.running = true;
    actor.act = "read";
    actor.flourish = "rise";
    actor.ride = { item: index, seat, ox: actor.x + SIZE / 2, oy: actor.y + SIZE };
    this.publish();
    this.schedule(actor, RISE_MS, () => {
      actor.flourish = null;
      actor.ride = null;
      actor.running = false;
      actor.act = null;
      item.seats[seat] = { id: null, seated: false };
      actor.dur = 360;
      actor.y = this.standY;
      actor.x = clamp(actor.x + (seat === 0 ? -50 : 50), 6, this.maxX);
      this.rest(actor, rand(400, 900));
    });
    return true;
  }

  /** 끝에서 고개만 내밀고 두리번거린 뒤 걸어 들어온다. */
  private enterByPeek(actor: Actor, fromLeft: boolean): void {
    const width = this.layout?.width ?? 0;
    actor.mode = "rest";
    actor.flourish = "peek";
    actor.x = fromLeft ? -SIZE * 0.45 : width - SIZE * 0.55;
    actor.y = this.standY;
    actor.dur = 0;
    actor.look = fromLeft ? 1 : -1;
    this.publish();
    this.schedule(actor, PEEK_MS, () => {
      actor.flourish = null;
      const target = fromLeft ? rand(20, Math.min(this.maxX, 240)) : rand(Math.max(20, this.maxX - 240), this.maxX);
      this.walkTo(actor, target, () => this.rest(actor, rand(300, 900)));
    });
  }

  /** 퇴장 — 가끔 미끄럼틀을 한 번 타고, 아니면 가까운 끝으로 걸어 나간다. 둘이 함께 나갈 때는 미끄럼틀을 쓰지 않는다. */
  private leave(actor: Actor, together = false): void {
    if (actor.exiting) return;
    actor.exiting = true;
    actor.flourish = null;
    if (actor.ride) this.releaseRide(actor);
    const slide = !together ? this.items.findIndex((item) => item.kind === "slide" && item.seats[0]!.id === null) : -1;
    if (slide >= 0 && Math.random() < 0.3) {
      this.goRide(actor, slide, 0);
      return;
    }
    this.walkOff(actor);
  }

  private walkOff(actor: Actor): void {
    const width = this.layout?.width ?? 0;
    const target = actor.x + SIZE / 2 < width / 2 ? -SIZE - 8 : width + 8;
    this.walkTo(actor, target, () => {
      this.cancel(actor);
      this.releaseRide(actor);
      this.actors = this.actors.filter((candidate) => candidate !== actor);
      this.publish();
    });
  }

  private releaseRide(actor: Actor): void {
    const ride = actor.ride;
    if (!ride) return;
    const item = this.items[ride.item];
    if (item) {
      item.seats[ride.seat] = { id: null, seated: false };
      if (item.kind !== "seesaw" || item.seats.every((seat) => seat.id === null)) item.going = false;
    }
    actor.ride = null;
  }

  /** 정지 장면 — 모두 한꺼번에 서고, 기구 자리를 먼저 채운 뒤 나머지는 소품 포즈로 선다. */
  private stillScene(): void {
    const queue = [...this.actors];
    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index]!;
      const riders = item.kind === "seesaw" ? 2 : 1;
      if (item.kind === "seesaw" && queue.length < 2) continue;
      for (let seat = 0; seat < riders; seat += 1) {
        const actor = queue.shift();
        if (!actor) break;
        actor.present = true;
        item.seats[seat] = { id: actor.cast.id, seated: true };
        this.seat(actor, index, seat);
        if (item.kind === "sand") { actor.running = true; actor.act = "read"; }
        if (item.kind === "slide") { actor.x = item.cx - ITEM_WIDTH.slide / 2 + 20 - SIZE / 2; actor.y = this.standY; actor.ride = null; actor.mode = "rest"; }
      }
      if (item.kind === "seesaw") item.going = item.seats.every((seat) => seat.seated);
    }
    const poses: readonly (MongleActivity | null)[] = ["read", null, "think", "edit", null];
    const slots = queue.length;
    queue.forEach((actor, index) => {
      actor.present = true;
      actor.mode = "rest";
      actor.y = this.standY;
      actor.x = clamp(((index + 0.5) / slots) * (this.layout?.width ?? 0) - SIZE / 2 + rand(-30, 30), 6, this.maxX);
      const act = poses[index % poses.length] ?? null;
      actor.running = act !== null;
      actor.act = act;
    });
  }

  // ── 타이머 ──
  private schedule(actor: Actor, ms: number, task: () => void): void {
    if (actor.timer) clearTimeout(actor.timer);
    actor.task = task;
    actor.deadline = performance.now() + ms;
    actor.remaining = null;
    actor.timer = setTimeout(() => {
      actor.timer = null;
      actor.task = null;
      if (!this.disposed && !this.frozen && !this.held) task();
    }, ms);
  }
  private cancel(actor: Actor): void {
    if (actor.timer) clearTimeout(actor.timer);
    actor.timer = null;
    actor.task = null;
    actor.remaining = null;
  }
  private clearTimers(): void {
    for (const actor of this.actors) this.cancel(actor);
    if (this.entryTimer) clearTimeout(this.entryTimer);
    this.entryTimer = null;
    this.entryRemaining = null;
    this.entryResume = null;
    if (this.directorTimer) clearTimeout(this.directorTimer);
    this.directorTimer = null;
    this.directorRemaining = null;
    this.directorResume = null;
    if (this.companionTimer) clearTimeout(this.companionTimer);
    this.companionTimer = null;
    this.companionRemaining = null;
    this.companionResume = null;
  }

  // ── 행동 ──
  private tick(actor: Actor): void {
    if (this.frozen || !this.layout || actor.exiting) return;
    const waiting = this.items.findIndex((item) => item.kind === "seesaw" && item.seats[0]!.id !== null && item.seats[1]!.id === null);
    const r = Math.random();
    if (waiting >= 0 && r < 0.5) { this.goRide(actor, waiting, 1); return; }
    if (r < 0.32) { this.wander(actor); return; }
    if (r < 0.64) {
      const free = this.items.map((item, index) => ({ item, index })).filter(({ item }) => item.seats.some((seat) => seat.id === null));
      if (free.length > 0) {
        const { item, index } = pick(free);
        this.goRide(actor, index, item.seats.findIndex((seat) => seat.id === null));
        return;
      }
      this.wander(actor);
      return;
    }
    if (r < 0.8 && this.chat(actor)) return;
    if (r < 0.93) { this.soloAct(actor); return; }
    this.rest(actor, rand(1600, 3600));
  }

  private rest(actor: Actor, ms: number): void {
    actor.mode = "rest";
    actor.running = false;
    actor.act = null;
    actor.look = 0;
    this.publish();
    this.schedule(actor, ms, () => this.tick(actor));
  }

  private wander(actor: Actor): void {
    const max = this.maxX;
    const dir = actor.x < 40 ? 1 : actor.x > max - 40 ? -1 : Math.random() < 0.5 ? -1 : 1;
    const target = clamp(actor.x + dir * rand(90, 300), 6, max);
    if (Math.abs(target - actor.x) < 30) { this.rest(actor, 500); return; }
    this.walkTo(actor, target, () => this.rest(actor, rand(200, 800)));
  }

  private walkTo(actor: Actor, target: number, then: () => void): void {
    const distance = Math.abs(target - actor.x);
    const ms = (distance / rand(36, 56)) * 1000;
    actor.mode = "walk";
    actor.running = false;
    actor.act = null;
    actor.walking = distance > 2;
    actor.look = target > actor.x ? 1 : target < actor.x ? -1 : 0;
    actor.dur = ms;
    actor.x = target;
    actor.y = this.standY;
    this.publish();
    this.schedule(actor, ms, () => {
      actor.walking = false;
      actor.look = 0;
      actor.dur = 0;
      then();
    });
  }

  private soloAct(actor: Actor): void {
    const [act, ms] = pick(SOLO_ACTS);
    actor.mode = "act";
    actor.running = true;
    actor.act = act;
    this.publish();
    this.schedule(actor, ms, () => this.rest(actor, rand(300, 900)));
  }

  /** 가까이 쉬는 몽글이가 있으면 말을 건다 — 한쪽은 말풍선, 다른 쪽은 손인사. */
  private chat(actor: Actor): boolean {
    const other = this.actors.find((candidate) => candidate !== actor && candidate.present && candidate.mode === "rest" && Math.abs(candidate.x - actor.x) < 140);
    if (!other) return false;
    this.cancel(other);
    actor.mode = other.mode = "chat";
    actor.look = other.x > actor.x ? 1 : -1;
    other.look = actor.x > other.x ? 1 : -1;
    actor.running = true;
    actor.act = "text";
    other.running = true;
    other.act = "delegate";
    this.publish();
    this.schedule(actor, 3400, () => this.rest(actor, rand(300, 900)));
    this.schedule(other, 3400, () => this.rest(other, rand(900, 1800)));
    return true;
  }

  /** 자리를 먼저 맡고 기구 앞까지 걸어간 뒤 앉는다. */
  private goRide(actor: Actor, index: number, seatIndex: number): void {
    const item = this.items[index];
    if (!item || seatIndex < 0 || item.seats[seatIndex]!.id !== null) {
      if (actor.exiting) this.walkOff(actor);
      else this.wander(actor);
      return;
    }
    item.seats[seatIndex] = { id: actor.cast.id, seated: false };
    const approach = clamp(this.seatX(item, seatIndex), 6, this.maxX);
    this.walkTo(actor, approach, () => this.mount(actor, index, seatIndex));
  }

  private seatX(item: Item, seat: number): number {
    const left = item.cx - ITEM_WIDTH[item.kind] / 2;
    switch (item.kind) {
      case "swing": return item.cx - SIZE / 2;
      case "seesaw": return item.cx + (seat === 0 ? -74 : 74) - SIZE / 2;
      case "sand": return item.cx + (seat === 0 ? -46 : 46) - SIZE / 2;
      case "slide": return left + 20 - SIZE / 2;
    }
  }

  /** 자리 좌표와 회전 기준점(기구의 축)을 배우에 싣는다. */
  private seat(actor: Actor, index: number, seatIndex: number): void {
    const item = this.items[index]!;
    const g = this.ground;
    actor.mode = "ride";
    actor.x = this.seatX(item, seatIndex);
    actor.y = item.kind === "swing" ? g - 28 - SIZE + 4
      : item.kind === "seesaw" ? g - 31 - SIZE + 2
        : item.kind === "sand" ? g - SIZE + 7
          : this.standY;
    const pivot = item.kind === "swing" ? { x: item.cx, y: g - 134 } : item.kind === "seesaw" ? { x: item.cx, y: g - 28 } : { x: actor.x + SIZE / 2, y: actor.y + SIZE };
    actor.ride = { item: index, seat: seatIndex, ox: pivot.x - actor.x, oy: pivot.y - actor.y };
  }

  private mount(actor: Actor, index: number, seatIndex: number): void {
    const item = this.items[index]!;
    actor.dur = item.kind === "slide" ? 0 : 280;
    this.seat(actor, index, seatIndex);
    item.seats[seatIndex]!.seated = true;
    actor.look = 0;
    switch (item.kind) {
      case "swing": {
        actor.running = true;
        actor.act = "run";
        item.going = true;
        this.publish();
        this.schedule(actor, SWING_PERIOD_MS * randInt(3, 5), () => this.dismount(actor));
        return;
      }
      case "seesaw": {
        const other = item.seats[seatIndex === 0 ? 1 : 0]!;
        actor.running = Math.random() < 0.5;
        actor.act = actor.running ? pick(["text", "delegate"] as const) : null;
        if (other.id !== null && other.seated) {
          const partner = this.actors.find((candidate) => candidate.cast.id === other.id);
          if (partner) this.cancel(partner);
          item.going = true;
          this.publish();
          // 마지막에 앉은 쪽이 시소를 쥔다 — 키프레임 처음(왼쪽이 내려간 자세)에서 끝나도록 주기의 배수만큼 탄다.
          this.schedule(actor, SEESAW_PERIOD_MS * randInt(2, 4), () => {
            item.going = false;
            if (partner) this.dismount(partner);
            this.dismount(actor);
          });
          return;
        }
        this.publish();
        this.waitForPartner(actor, item, seatIndex);
        return;
      }
      case "sand": {
        actor.running = true;
        actor.act = pick(SAND_ACTS);
        this.publish();
        this.schedule(actor, rand(3500, 5500), () => {
          actor.act = pick(SAND_ACTS.filter((act) => act !== actor.act));
          this.publish();
          this.schedule(actor, rand(3000, 5000), () => this.dismount(actor));
        });
        return;
      }
      case "slide": {
        actor.running = false;
        actor.act = null;
        actor.slideRun += 1;
        this.publish();
        this.schedule(actor, SLIDE_CLIMB_MS, () => {
          actor.running = true;
          actor.act = "run";
          this.publish();
          this.schedule(actor, SLIDE_TOTAL_MS - SLIDE_CLIMB_MS, () => {
            // 키프레임 끝 좌표로 몸을 옮기고 같은 커밋에서 탈것을 내린다 — 튀지 않는다.
            actor.ride = null;
            actor.dur = 0;
            actor.x += SLIDE_RUN_X;
            item.seats[0] = { id: null, seated: false };
            if (actor.exiting) { this.walkOff(actor); return; }
            this.rest(actor, rand(500, 1200));
          });
        });
        return;
      }
    }
  }

  /** 시소에 혼자 앉으면 짝을 잠깐 기다린다. 짝이 오는 중이면 더 기다린다. */
  private waitForPartner(actor: Actor, item: Item, seatIndex: number): void {
    this.schedule(actor, rand(5000, 9000), () => {
      if (item.seats[seatIndex === 0 ? 1 : 0]!.id !== null) { this.waitForPartner(actor, item, seatIndex); return; }
      this.dismount(actor);
    });
  }

  private dismount(actor: Actor): void {
    const ride = actor.ride;
    if (ride) {
      const item = this.items[ride.item];
      if (item) {
        item.seats[ride.seat] = { id: null, seated: false };
        if (item.kind !== "seesaw" || item.seats.every((seat) => seat.id === null)) item.going = false;
      }
    }
    actor.ride = null;
    actor.dur = 300;
    actor.y = this.standY;
    actor.x = clamp(actor.x + (Math.random() < 0.5 ? -1 : 1) * rand(20, 44), 6, this.maxX);
    if (actor.exiting) { this.walkOff(actor); return; }
    this.rest(actor, rand(400, 1200));
  }

  // ── 얼음·떠난 화면 ──
  /** 타이머만 멈춘다. 배우의 자리·탈것·연출은 그대로 두고, 남은 시간만 기억한다. */
  private pauseClock(): void {
    const now = performance.now();
    for (const actor of this.actors) {
      if (!actor.timer) continue;
      clearTimeout(actor.timer);
      actor.timer = null;
      actor.remaining = Math.max(0, actor.deadline - now);
    }
    if (this.entryTimer) {
      clearTimeout(this.entryTimer);
      this.entryTimer = null;
      this.entryRemaining = Math.max(0, this.entryDeadline - now);
    }
    if (this.directorTimer) {
      clearTimeout(this.directorTimer);
      this.directorTimer = null;
      this.directorRemaining = Math.max(0, this.directorDeadline - now);
    }
    if (this.companionTimer) {
      clearTimeout(this.companionTimer);
      this.companionTimer = null;
      this.companionRemaining = Math.max(0, this.companionDeadline - now);
    }
  }

  /** 멈춰 둔 타이머를 남은 시간부터 다시 건다. `minLeadMs` 는 새 등장 예약에만 적용한다. */
  private rearmClock(minLeadMs: number): void {
    this.actors.forEach((actor, index) => {
      if (!actor.present) return;
      const task = actor.task;
      if (actor.exiting && (actor.remaining === null || !task)) { this.walkOff(actor); return; }
      if (actor.remaining === null || !task) {
        if (actor.mode === "rest" || actor.mode === "walk") this.schedule(actor, 200 + index * 260, () => this.tick(actor));
        return;
      }
      this.schedule(actor, actor.remaining, task);
    });
    const lead = (ms: number) => Math.max(minLeadMs, ms);
    if (this.entryRemaining !== null && this.entryResume) {
      const resume = this.entryResume;
      this.armEntry(lead(this.entryRemaining), resume);
      this.entryRemaining = null;
    }
    if (this.directorRemaining !== null && this.directorResume) {
      const resume = this.directorResume;
      this.armDirector(lead(this.directorRemaining), resume);
      this.directorRemaining = null;
    }
    if (this.companionRemaining !== null && this.companionResume) {
      const resume = this.companionResume;
      this.armCompanion(lead(this.companionRemaining), resume);
      this.companionRemaining = null;
    }
    // 연출 예약이 한 번도 없던 무대(빈 레이아웃으로 시작해 얼어 있는 동안 커진 경우 등)도 다시 돌게 한다.
    if (this.dynamic && this.layout && this.directorTimer === null && this.directorRemaining === null) {
      this.armDirector(minLeadMs, () => {
        this.directorTimer = null;
        this.directorResume = null;
        this.direct();
      });
    }
  }

  /** 같은 DOM 에 붙은 CSS 애니메이션과 transform 전이를 멈춘다. currentTime 은 그 객체에 남는다. */
  private pauseAnimations(): void {
    const root = sceneHost;
    if (!root || this.pausedAnimations.length > 0) return;
    this.pausedAnimations = root.getAnimations({ subtree: true }).map((animation) => ({
      animation,
      time: Number(animation.currentTime ?? 0),
    }));
    for (const paused of this.pausedAnimations) paused.animation.pause();
  }

  private playAnimations(): void {
    for (const paused of this.pausedAnimations) {
      // 노드를 옮기며 취소된 객체(idle)는 다시 켜지 않는다 — 그 자리에는 CSS 가 새 객체를 이미 세웠다.
      if (paused.animation.playState !== "paused") continue;
      try {
        paused.animation.currentTime = paused.time;
        paused.animation.play();
      } catch { /* 이미 끝난 전이는 다시 켜지 않는다. */ }
    }
    this.pausedAnimations = [];
  }

  /** 입력·숨은 창 — 그 자리에서 멈추고, 풀리면 같은 진행부터 이어 간다. 자리를 옮기거나 탈것에서 내리지 않는다. */
  freeze(): void {
    if (this.frozen || this.held) return;
    this.frozen = true;
    this.pauseClock();
    this.pauseAnimations();
    this.publish();
  }

  thaw(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.playAnimations();
    this.rearmClock(0);
    this.publish();
  }

  get isDynamic(): boolean { return this.dynamic; }
  get isHeld(): boolean { return this.held; }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  /**
   * 새 세션 화면이 걷힐 때. 배우·탈것·연출·남은 예약은 모듈에 두고, 타이머와 CSS 만 그 순간에 멈춘다.
   * 닫혀 있던 시간은 장면에 더하지 않는다.
   */
  park(): void {
    if (this.held) return;
    // 입력으로 멈춰 있던 얼음은 이미 시계와 애니메이션을 그 순간에 세워 두었다. 같은 목록을 그대로 들고 간다.
    if (!this.frozen) {
      this.pauseClock();
      this.pauseAnimations();
    }
    this.frozen = false;
    this.watching = false;
    this.held = true;
    this.awaySince = performance.now();
  }

  /**
   * 같은 창에서 다시 들어올 때. 호출부는 장면을 슬롯에 옮긴 뒤에 부른다.
   * `moveBefore` 로 옮겼으면 멈춰 둔 애니메이션·전이 객체가 그대로 남아 있어 그 시각부터 이어 간다.
   * 새 등장은 다시 들어온 직후에 끼어들지 않도록 조금 늦춘다.
   */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    if (this.awaySince !== null) this.awayMs += Math.max(0, performance.now() - this.awaySince);
    this.awaySince = null;
    this.playAnimations();
    this.rearmClock(REENTRY_HOLD_MS);
    this.publish();
  }

  setWatching(value: boolean): void {
    if (this.watching === value) return;
    this.watching = value;
    this.publish();
  }
}

/**
 * 클라이언트 세션에 무대를 하나만 둔다. 새 세션 화면이 닫혀도 이 객체가 배우를 쥐고,
 * 그리기·위치 읽기는 지금 열려 있는 화면으로만 연결한다. 화면이 없으면 알림은 버려진다.
 */
let sessionStage: PlaygroundStage | null = null;
let sessionPublish: () => void = () => {};
let sessionPinX: (id: string) => number | null = () => null;

function acquireSessionStage(): PlaygroundStage {
  sessionStage ??= new PlaygroundStage(() => sessionPublish(), (id) => sessionPinX(id));
  return sessionStage;
}

/** 새 세션 화면의 놀이터 층. 장면 DOM 은 이 모듈의 React 루트에 남아, 화면을 떠나도 애니메이션 객체가 없어지지 않는다. */
let sceneHost: HTMLDivElement | null = null;
let sceneRoot: ReturnType<typeof createRoot> | null = null;

function sceneParking(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".pg-scene-park");
  if (existing) return existing;
  const dock = document.createElement("div");
  dock.className = "pg-scene-park";
  document.body.appendChild(dock);
  return dock;
}

/**
 * 장면을 다른 부모로 옮긴다. `moveBefore` 는 노드를 떼지 않고 옮겨 CSS 애니메이션·전이 객체가 그대로 남는다
 * (Chromium·Electron Desktop). 없는 엔진은 일반 이동으로 물러나며, 그때 CSS 애니메이션은 처음부터 다시 돈다.
 */
function moveScene(parent: HTMLElement, host: HTMLElement): void {
  const atomic = (parent as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
  if (typeof atomic === "function" && parent.isConnected && host.isConnected) {
    try {
      atomic.call(parent, host, null);
      return;
    } catch { /* 문서가 다르면 일반 이동으로 물러난다. */ }
  }
  parent.appendChild(host);
}

function ensureSceneHost(): HTMLDivElement {
  // 보관소는 장면과 함께 미리 세운다. 처음 떠나는 순간에 막 만든 보관소로 옮기면 걷던 전이가 끊긴다(실측).
  sceneParking();
  if (!sceneHost || !sceneRoot) {
    const host = document.createElement("div");
    host.className = "pg-scene-host";
    const root = createRoot(host);
    flushSync(() => { root.render(<PlaygroundScene />); });
    sceneHost = host;
    sceneRoot = root;
  }
  return sceneHost;
}

/** 열려 있는 새 세션 칸에 측정·입력·창 가시기를 붙인다. 장면을 지우지는 않는다. */
function bindPlayground(layer: HTMLElement, stage: PlaygroundStage): () => void {
  const body = layer.closest<HTMLElement>(".new-session-body");
  const column = layer.closest<HTMLElement>(".new-session");
  if (!body) return () => {};
  const cards = body.querySelector<HTMLElement>(".new-session-cards");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;
  const still = () => reduced.matches || root.dataset.avatarMotion === "calm";

  let typing = false;
  let lastKey = "";
  const measure = (force = false) => {
    if (stage.isHeld) return;
    const box = layer.getBoundingClientRect();
    const cardBottom = cards ? cards.getBoundingClientRect().bottom - box.top : 0;
    const room = box.height - cardBottom - 10;
    let layout: Layout | null = null;
    const fullScale = Math.min(1, room / BAND_FULL);
    if (fullScale >= MIN_SCALE) layout = { width: box.width / fullScale, band: BAND_FULL, scale: fullScale, withItems: true };
    else {
      const walkScale = Math.min(1, room / BAND_WALK);
      if (walkScale >= MIN_SCALE) layout = { width: box.width / walkScale, band: BAND_WALK, scale: walkScale, withItems: false };
    }
    const key = layout ? `${Math.round(layout.width / 8)}:${layout.band}:${layout.scale.toFixed(2)}:${still()}` : `none:${still()}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    stage.setup(layout, !still());
    if (stage.isDynamic && (document.hidden || typing)) stage.freeze();
  };
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  // 첫 무대는 크기가 자리 잡은 뒤에 세운다 — 다른 화면에서 넘어오면 열 폭이 전이하는 동안 기구 수가 달라 보이지 않게.
  let settled = false;
  let settleFrame = 0;
  let settleKey = "";
  let stableFrames = 0;
  const settleStart = performance.now();
  const settle = () => {
    const box = layer.getBoundingClientRect();
    const key = `${box.width}x${box.height}:${cards?.getBoundingClientRect().bottom ?? 0}`;
    stableFrames = key === settleKey ? stableFrames + 1 : 0;
    settleKey = key;
    if (stableFrames >= 10 || performance.now() - settleStart > 1200) {
      settled = true;
      measure(true);
      return;
    }
    settleFrame = requestAnimationFrame(settle);
  };
  const observer = new ResizeObserver(() => {
    if (!settled || stage.isHeld) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => measure(), 180);
  });
  observer.observe(layer);
  if (cards) observer.observe(cards);
  settleFrame = requestAnimationFrame(settle);

  const restage = () => { if (settled && !stage.isHeld) measure(true); };
  reduced.addEventListener("change", restage);
  const calmObserver = new MutationObserver(restage);
  calmObserver.observe(root, { attributes: true, attributeFilter: ["data-avatar-motion"] });

  let thawTimer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    typing = false;
    stage.setWatching(false);
    if (!document.hidden && !stage.isHeld) stage.thaw();
  };
  const onInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !stage.isDynamic || stage.isHeld) return;
    if (thawTimer) clearTimeout(thawTimer);
    if (target.value.trim().length === 0) { release(); return; }
    typing = true;
    stage.setWatching(true);
    stage.freeze();
    thawTimer = setTimeout(release, FREEZE_IDLE_MS);
  };
  column?.addEventListener("input", onInput);
  const onVisibility = () => {
    if (!stage.isDynamic || stage.isHeld) return;
    if (document.hidden) stage.freeze();
    else if (!typing) stage.thaw();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    cancelAnimationFrame(settleFrame);
    observer.disconnect();
    calmObserver.disconnect();
    reduced.removeEventListener("change", restage);
    column?.removeEventListener("input", onInput);
    document.removeEventListener("visibilitychange", onVisibility);
    if (resizeTimer) clearTimeout(resizeTimer);
    if (thawTimer) clearTimeout(thawTimer);
  };
}

export function NewSessionPlayground() {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const stage = acquireSessionStage();
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const host = ensureSceneHost();
    let cleanup = () => {};
    let frame = 0;
    const attach = () => {
      const layer = host.querySelector<HTMLElement>(":scope > .new-session-playground");
      if (!layer) { frame = requestAnimationFrame(attach); return; }
      host.classList.remove("is-parked");
      moveScene(slot, host);
      stage.resume();
      cleanup = bindPlayground(layer, stage);
    };
    frame = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(frame);
      cleanup();
      stage.park();
      host.classList.add("is-parked");
      moveScene(sceneParking(), host);
    };
  }, [stage]);
  return <div ref={slotRef} className="new-session-playground-slot" aria-hidden="true" />;
}

/** 모듈에 한 번만 마운트되는 장면. 새 세션 칸이 사라져도 이 트리는 풀리지 않는다. */
function PlaygroundScene() {
  const actorRefs = useRef(new Map<string, HTMLDivElement>());
  const [, setVersion] = useState(0);
  const stage = acquireSessionStage();
  // 그리기 알림은 첫 렌더에서 바로 연결한다. effect 까지 미루면 첫 setup 의 publish 가 버려지고 밴드가 안 선다.
  sessionPublish = (sync?: boolean) => {
    const run = () => setVersion((value) => value + 1);
    if (sync) flushSync(run);
    else run();
  };
  sessionPinX = (id) => {
    const element = actorRefs.current.get(id);
    if (!element) return null;
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === "none") return null;
    return new DOMMatrixReadOnly(transform).m41;
  };

  const layout = stage.layout;
  const className = ["new-session-playground", stage.frozen ? "is-frozen" : null, stage.watching ? "is-watching" : null, stage.isDynamic ? null : "is-still"].filter(Boolean).join(" ");
  return (
    <div className={className} aria-hidden="true">
      {layout ? (
        <div className="pg-band" style={{ width: `${layout.width}px`, height: `${layout.band}px`, transform: `scale(${layout.scale})` }}>
          {stage.items.map((item, index) => <PlaygroundItem key={`${item.kind}:${index}`} item={item} ground={stage.ground} />)}
          {stage.actors.filter((actor) => actor.present).map((actor) => {
            const item = actor.ride ? stage.items[actor.ride.item] : undefined;
            const ride = item ? rideClass(item, actor) : null;
            const style = {
              transform: `translate3d(${actor.x.toFixed(1)}px, ${actor.y.toFixed(1)}px, 0)`,
              transition: actor.dur > 0 ? `transform ${Math.round(actor.dur)}ms ${actor.mode === "walk" ? "linear" : "ease-out"}` : "none",
              "--pg-ox": actor.ride ? `${actor.ride.ox}px` : "50%",
              "--pg-oy": actor.ride ? `${actor.ride.oy}px` : "100%",
            } as CSSProperties;
            const actorClass = ["pg-actor", actor.look < 0 ? "is-look-left" : actor.look > 0 ? "is-look-right" : null, item?.kind === "sand" ? "is-in-sand" : null].filter(Boolean).join(" ");
            const rideName = ["pg-ride", ride, actor.flourish === "slide-in" ? "is-slide-in" : null].filter(Boolean).join(" ");
            const popName = ["pg-pop", actor.flourish === "rise" ? "is-rise" : null, actor.flourish === "peek" ? "is-peek" : null].filter(Boolean).join(" ");
            return (
              <div key={actor.cast.id} ref={(element) => { if (element) actorRefs.current.set(actor.cast.id, element); else actorRefs.current.delete(actor.cast.id); }} className={actorClass} style={style} data-pg-id={actor.cast.id} data-pg-face={actor.cast.key} data-pg-flourish={actor.flourish ?? ""}>
                <div key={actor.flourish === "slide-in" || ride === "is-sliding" ? `slide-${actor.slideRun}` : "ride"} className={rideName}>
                  <div key={actor.flourish ?? "pop"} className={popName}>
                    <div className={`pg-gait${actor.walking ? " is-walking" : ""}`}>
                      <MongleAvatar base={actor.cast.base} tone={actor.cast.tone} role={actor.cast.role} state={actor.running ? "running" : "idle"} activity={actor.running ? actor.act : null} size={SIZE} label="" decorative />
                    </div>
                  </div>
                </div>
                {actor.ride ? null : <div className="pg-shadow" />}
              </div>
            );
          })}
          {stage.items.map((item, index) => item.kind === "sand" ? <SandLip key={`lip:${index}`} item={item} ground={stage.ground} /> : null)}
        </div>
      ) : null}
    </div>
  );
}

function rideClass(item: Item, actor: Actor): string | null {
  switch (item.kind) {
    case "swing": return item.going ? "is-swinging" : null;
    case "seesaw": return item.going ? "is-rocking" : "is-tilted";
    case "slide": return actor.mode === "ride" ? "is-sliding" : null;
    case "sand": return null;
  }
}

function itemStyle(item: Item, ground: number): CSSProperties {
  return { left: `${item.cx - ITEM_WIDTH[item.kind] / 2}px`, top: `${ground}px` };
}

/** 기구 그림 — 선은 중립 잉크 한 가지(색 채널 규칙: 기구는 상태도 정체성도 아니다). 바닥선(top)에 아래쪽을 맞춘다. */
function PlaygroundItem({ item, ground }: { readonly item: Item; readonly ground: number }) {
  switch (item.kind) {
    case "swing":
      return (
        <div className="pg-item is-swing" style={itemStyle(item, ground)}>
          <svg className="pg-prop" width="116" height="140" viewBox="0 0 116 140"><path className="pg-line" d="M16 6H100M20 6L3 138M96 6l17 132" /><path className="pg-line is-thin" d="M9 88h9M98 88h9" /></svg>
          <div className={`pg-swing-arm${item.going ? " is-swinging" : ""}`}>
            <svg className="pg-prop" width="52" height="112" viewBox="0 0 52 112"><path className="pg-line is-thin" d="M6 0V106M46 0V106" /><path className="pg-line" d="M2 106H50" /></svg>
          </div>
        </div>
      );
    case "seesaw":
      return (
        <div className="pg-item is-seesaw" style={itemStyle(item, ground)}>
          <svg className="pg-prop" width="200" height="30" viewBox="0 0 200 30"><path className="pg-line" d="M86 29L100 3L114 29Z" /></svg>
          <div className={`pg-plank ${item.going ? "is-rocking" : "is-tilted"}`} />
        </div>
      );
    case "sand":
      return <div className="pg-item is-sand" style={itemStyle(item, ground)} />;
    case "slide":
      return (
        <div className="pg-item is-slide" style={itemStyle(item, ground)}>
          <svg className="pg-prop" width="176" height="140" viewBox="0 0 176 140">
            <path className="pg-line" d="M10 139V34M30 139V34M10 34H54" />
            <path className="pg-line is-thin" d="M10 116h20M10 94h20M10 72h20M10 50h20" />
            <path className="pg-line" d="M54 34C78 36 100 102 132 124Q142 132 172 132M54 42C76 46 96 112 128 132Q134 136 172 138" />
            <path className="pg-line is-thin" d="M44 34V139" />
          </svg>
        </div>
      );
  }
}

/** 모래밭 앞 테두리 — 앉은 몽글이 앞에 와서 모래에 반쯤 잠긴 것처럼 보인다. */
function SandLip({ item, ground }: { readonly item: Item; readonly ground: number }) {
  return (
    <div className="pg-item is-sand-lip" style={itemStyle(item, ground)}>
      <svg className="pg-prop" width="176" height="24" viewBox="0 0 176 24">
        <path className="pg-line" d="M4 23L11 8H165L172 23Z" />
        <circle className="pg-dot" cx="44" cy="17" r="1.3" /><circle className="pg-dot" cx="66" cy="19" r="1.1" /><circle className="pg-dot" cx="108" cy="17" r="1.3" /><circle className="pg-dot" cx="134" cy="19" r="1.1" />
      </svg>
    </div>
  );
}
