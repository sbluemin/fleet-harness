import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MONGLE_BASES, type MongleActivity, type MongleRole } from "@fleet-console/sdk/avatars";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";

import "./new-session-playground.css";

/**
 * 새 세션 화면의 「몽글 놀이터」 — 「어디서」 카드 아래 바닥선에서 몽글이들이 걷고(산책로), 그네·시소·모래밭·미끄럼틀에서 논다(놀이기구).
 * 승인안(목표 b4f89230): A 산책로 + C 놀이기구를 한 무대에 두고, 누가 언제 어느 기구로 가서 놀지·걷기·멈춰 연기하기를 랜덤으로 고른다.
 * 출연진은 Theater 와 무관하게 몽글 베이스 15종 전체다(사람의 지시로 「사령관 + 내 Operation」을 대체). 15종을 섞은 덱에서 뽑아 한 바퀴를
 * 돌기 전에는 같은 캐릭터가 다시 나오지 않고, 역할(안테나·구성원·별)은 등장할 때마다 랜덤이다. 오래 머문 몽글이는 가끔 가까운 끝으로 걸어
 * 나가고, 잠시 뒤 덱의 다음 캐릭터가 랜덤한 쪽에서 들어온다. 무대 위 동시 인원은 폭 상한을 넘지 않는다.
 *
 * - 배경 층이다: pointer-events 없음·aria-hidden. 카드와 컴포저 위로 오지 않고 클릭·포커스를 가져가지 않는다.
 * - 부르는 상태(대기·결정·검토의 발밑 빛, 안 본 답·오류·휴면 배지)는 놀이에 쓰지 않는다 — 쉼(idle)과 작업 중 연기(running+activity)만 쓴다.
 * - 「얼음」: 열(column)로 올라오는 input 이벤트만 듣는다(컴포저 코드는 건드리지 않음). 글이 있는 동안 멈춰 입력창 쪽을 보고, 1.6초 손을 떼면 다시 논다.
 * - 정지 장면: OS 움직임 줄이기·「아바타 차분하게」에서는 스케줄러 없이 소품 포즈로 선다. 숨은 창에서는 스케줄러가 쉰다.
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
/** 무대 위 동시 인원 — 폭이 넓을 때. 좁으면 4·3명. */
const STAGE_CAP = 6;
/** 이만큼 머문 뒤부터 틱마다 이 확률로 퇴장한다. */
const EXIT_AFTER_MS = 20_000;
const EXIT_CHANCE = 0.08;
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
  /** 등장마다 새 값 — 같은 베이스가 다음 바퀴에 다시 나와도 다른 배우다. */
  readonly id: string;
  readonly base: number;
  readonly role: MongleRole;
}

function randomRole(): MongleRole {
  const r = Math.random();
  return r < ROLE_COMMODORE ? "commodore" : r < ROLE_COMMANDER ? "commander" : "member";
}

interface Seat { id: string | null; seated: boolean }
interface Item { readonly kind: ItemKind; readonly cx: number; readonly seats: Seat[]; going: boolean }

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
 */
class PlaygroundStage {
  actors: Actor[] = [];
  items: Item[] = [];
  layout: Layout | null = null;
  frozen = false;
  private dynamic = true;
  private entryTimer: ReturnType<typeof setTimeout> | null = null;
  private entryRemaining: number | null = null;
  private entryDeadline = 0;
  private disposed = false;
  private cap = STAGE_CAP;
  private deck: number[] = [];
  private serial = 0;
  private entered = false;

  constructor(private readonly publish: () => void, private readonly pinX: (id: string) => number | null) {}

  get ground(): number { return (this.layout?.band ?? BAND_FULL) - FLOOR; }
  private get standY(): number { return this.ground - SIZE; }
  private get maxX(): number { return (this.layout?.width ?? 0) - SIZE - 6; }

  /** 크기가 바뀌거나 움직임 규칙이 바뀌면 장면을 새로 세운다. 이미 나온 배우는 다시 등장하지 않고 제자리 근처에 선다. */
  setup(layout: Layout | null, dynamic: boolean): void {
    // StrictMode 의 effect 재부착(setup→cleanup→setup)은 같은 무대를 다시 쓴다 — 앞선 dispose 를 되살린다.
    this.disposed = false;
    this.clearTimers();
    this.layout = layout;
    this.dynamic = dynamic;
    this.frozen = false;
    if (!layout) {
      this.actors = [];
      this.items = [];
      this.publish();
      return;
    }
    this.cap = layout.width < 520 ? 3 : layout.width < 820 ? 4 : STAGE_CAP;
    const itemCount = !layout.withItems ? 0 : layout.width >= 820 ? 4 : layout.width >= 470 ? 2 : layout.width >= 230 ? 1 : 0;
    const kinds = shuffle(ITEM_KINDS).slice(0, itemCount);
    this.items = kinds.map((kind, index) => ({
      kind,
      cx: (layout.width * (index + 0.5)) / itemCount,
      seats: Array.from({ length: ITEM_SEATS[kind] }, () => ({ id: null, seated: false })),
      going: false,
    }));
    // 이미 무대에 선 배우는 남기고(상한까지) 기구에서 내려 바닥에 세운다. 퇴장하던 배우도 그 자리에 선다.
    this.actors = this.actors.filter((actor) => actor.present).slice(0, this.cap);
    for (const actor of this.actors) {
      Object.assign(actor, { mode: "rest", x: rand(6, this.maxX), y: this.standY, dur: 0, look: 0, walking: false, running: false, act: null, ride: null, remaining: null });
    }
    if (!dynamic) {
      while (this.actors.length < this.cap) this.actors.push(this.cast());
      this.stillScene();
      this.publish();
      return;
    }
    for (const actor of this.actors) this.schedule(actor, rand(300, 1400), () => this.tick(actor));
    this.publish();
    this.fillEntries();
  }

  /** 덱의 다음 캐릭터 — 15종을 섞어 한 바퀴를 돈다. 새 바퀴의 앞머리가 지금 무대에 있으면 건너뛴다. */
  private cast(): Actor {
    const onStage = new Set(this.actors.map((actor) => actor.cast.base));
    let index = this.deck.findIndex((base) => !onStage.has(base));
    if (index < 0) {
      this.deck = shuffle(MONGLE_BASES.map((base) => base.id));
      index = this.deck.findIndex((base) => !onStage.has(base));
    }
    const [base] = this.deck.splice(Math.max(0, index), 1);
    this.serial += 1;
    return {
      cast: { id: `pg-${this.serial}`, base: base ?? 1, role: randomRole() },
      present: true, enteredAt: performance.now(), mode: "rest", x: -SIZE - 12, y: this.standY, dur: 0, look: 0, walking: false, running: false, act: null,
      ride: null, slideRun: 0, timer: null, deadline: 0, task: null, remaining: null,
    };
  }

  /** 빈자리가 있으면 다음 등장을 하나 예약한다 — 첫 등장은 금방, 그 뒤로는 1.5–6초 간격. 등장 타이머는 하나뿐이라 상한을 넘지 않는다. */
  private fillEntries(): void {
    if (this.disposed || !this.dynamic || !this.layout || this.entryTimer || this.entryRemaining !== null) return;
    if (this.actors.length >= this.cap) return;
    const first = !this.entered;
    this.entered = true;
    this.armEntry(first ? rand(400, 1800) : rand(1500, 6000), () => {
      this.entryTimer = null;
      this.entryResume = null;
      if (this.disposed || this.actors.length >= this.cap) return;
      this.enter(this.cast());
      this.fillEntries();
    });
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

  private enter(actor: Actor): void {
    const fromLeft = Math.random() < 0.5;
    this.actors.push(actor);
    actor.enteredAt = performance.now();
    actor.mode = "walk";
    actor.x = fromLeft ? -SIZE - 8 : (this.layout?.width ?? 0) + 8;
    actor.y = this.standY;
    actor.dur = 0;
    this.publish();
    // 화면 밖 자리가 한 번 그려진 뒤 걸어 들어온다(전이 시작점).
    this.schedule(actor, 80, () => {
      const target = fromLeft ? rand(10, Math.min(this.maxX, 260)) : rand(Math.max(10, this.maxX - 260), this.maxX);
      this.walkTo(actor, target, () => this.rest(actor, rand(300, 900)));
    });
  }

  /** 퇴장 — 가까운 끝 너머로 걸어 나가고, 닿으면 무대에서 빠진 뒤 다음 등장을 예약한다. */
  private leave(actor: Actor): void {
    const width = this.layout?.width ?? 0;
    const target = actor.x + SIZE / 2 < width / 2 ? -SIZE - 8 : width + 8;
    this.walkTo(actor, target, () => {
      this.cancel(actor);
      this.actors = this.actors.filter((candidate) => candidate !== actor);
      this.publish();
      this.fillEntries();
    });
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
      if (!this.disposed && !this.frozen) task();
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
  }

  // ── 행동 ──
  private tick(actor: Actor): void {
    if (this.frozen || !this.layout) return;
    // 기구를 타지 않을 때만 틱이 돈다 — 오래 머문 몽글이는 가끔 퇴장한다.
    if (performance.now() - actor.enteredAt >= EXIT_AFTER_MS && Math.random() < EXIT_CHANCE) { this.leave(actor); return; }
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
    if (!item || seatIndex < 0 || item.seats[seatIndex]!.id !== null) { this.wander(actor); return; }
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
    this.rest(actor, rand(400, 1200));
  }

  // ── 얼음·숨은 창 ──
  /** 멈춘다 — 걷던 몽글이는 지금 자리에 서고, 남은 타이머는 남은 시간을 기억한다. 기구·연기는 CSS 가 그 자리에서 멈춘다. */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    const now = performance.now();
    for (const actor of this.actors) {
      if (actor.mode === "walk" && actor.present) {
        this.cancel(actor);
        // 기구로 가던 길이면 앉지 않은 예약을 푼다 — 녹은 뒤 새로 고르므로, 남기면 그 자리는 다시 쓰이지 않는다.
        for (const item of this.items) {
          item.seats.forEach((seat, index) => {
            if (seat.id === actor.cast.id && !seat.seated) item.seats[index] = { id: null, seated: false };
          });
        }
        const x = this.pinX(actor.cast.id);
        if (x !== null) actor.x = x;
        actor.dur = 0;
        actor.walking = false;
        actor.look = 0;
        actor.mode = "rest";
        actor.remaining = -1;
        continue;
      }
      if (actor.timer) {
        clearTimeout(actor.timer);
        actor.timer = null;
        actor.remaining = Math.max(0, actor.deadline - now);
      }
    }
    if (this.entryTimer) {
      clearTimeout(this.entryTimer);
      this.entryTimer = null;
      this.entryRemaining = Math.max(0, this.entryDeadline - now);
    }
    this.publish();
  }

  thaw(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.actors.forEach((actor, index) => {
      if (!actor.present) return;
      const task = actor.task;
      if (actor.remaining === -1 || !task) {
        if (actor.mode === "rest" || actor.mode === "walk") this.schedule(actor, 200 + index * 260, () => this.tick(actor));
        return;
      }
      if (actor.remaining !== null) this.schedule(actor, actor.remaining, task);
    });
    if (this.entryRemaining !== null && this.entryResume) {
      const resume = this.entryResume;
      this.armEntry(this.entryRemaining, resume);
      this.entryRemaining = null;
    }
    this.publish();
  }

  get isDynamic(): boolean { return this.dynamic; }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }
}

/** 새 세션 화면의 놀이터 층. 출연진은 Theater 와 무관하게 몽글 베이스 15종에서 뽑는다. */
export function NewSessionPlayground() {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const actorRefs = useRef(new Map<string, HTMLDivElement>());
  const [, setVersion] = useState(0);
  const [watching, setWatching] = useState(false);
  const stageRef = useRef<PlaygroundStage | null>(null);
  if (!stageRef.current) {
    stageRef.current = new PlaygroundStage(() => setVersion((value) => value + 1), (id) => {
      const element = actorRefs.current.get(id);
      if (!element) return null;
      const transform = getComputedStyle(element).transform;
      if (!transform || transform === "none") return null;
      return new DOMMatrixReadOnly(transform).m41;
    });
  }
  const stage = stageRef.current;

  useEffect(() => {
    const layer = layerRef.current;
    const body = layer?.parentElement;
    const column = layer?.closest<HTMLElement>(".new-session");
    if (!layer || !body) return;
    const cards = body.querySelector<HTMLElement>(".new-session-cards");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    const still = () => reduced.matches || root.dataset.avatarMotion === "calm";

    let typing = false;
    let lastKey = "";
    const measure = (force = false) => {
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
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => measure(), 180);
    });
    observer.observe(layer);
    if (cards) observer.observe(cards);
    measure(true);

    const restage = () => measure(true);
    reduced.addEventListener("change", restage);
    const calmObserver = new MutationObserver(restage);
    calmObserver.observe(root, { attributes: true, attributeFilter: ["data-avatar-motion"] });

    // 「얼음」 — 열로 올라오는 input 만 듣는다. 컴포저(textarea)에 글이 있으면 멈추고 1.6초 손을 떼면 다시 논다.
    let thawTimer: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      typing = false;
      setWatching(false);
      if (!document.hidden) stage.thaw();
    };
    const onInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || !stage.isDynamic) return;
      if (thawTimer) clearTimeout(thawTimer);
      if (target.value.trim().length === 0) { release(); return; }
      typing = true;
      setWatching(true);
      stage.freeze();
      thawTimer = setTimeout(release, FREEZE_IDLE_MS);
    };
    column?.addEventListener("input", onInput);
    const onVisibility = () => {
      if (!stage.isDynamic) return;
      if (document.hidden) stage.freeze();
      else if (!typing) stage.thaw();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      observer.disconnect();
      calmObserver.disconnect();
      reduced.removeEventListener("change", restage);
      column?.removeEventListener("input", onInput);
      document.removeEventListener("visibilitychange", onVisibility);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (thawTimer) clearTimeout(thawTimer);
      stage.dispose();
    };
  }, [stage]);

  const layout = stage.layout;
  const className = ["new-session-playground", stage.frozen ? "is-frozen" : null, watching ? "is-watching" : null, stage.isDynamic ? null : "is-still"].filter(Boolean).join(" ");
  return (
    <div ref={layerRef} className={className} aria-hidden="true">
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
            return (
              <div key={actor.cast.id} ref={(element) => { if (element) actorRefs.current.set(actor.cast.id, element); else actorRefs.current.delete(actor.cast.id); }} className={actorClass} style={style}>
                <div key={ride === "is-sliding" ? `slide-${actor.slideRun}` : "ride"} className={`pg-ride${ride ? ` ${ride}` : ""}`}>
                  <div className={`pg-gait${actor.walking ? " is-walking" : ""}`}>
                    <MongleAvatar base={actor.cast.base} tone={null} role={actor.cast.role} state={actor.running ? "running" : "idle"} activity={actor.running ? actor.act : null} size={SIZE} label="" decorative />
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
