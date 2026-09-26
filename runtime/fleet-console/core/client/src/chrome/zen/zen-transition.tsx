import { useEffect, useRef } from "react";

import { BrandMarkIcon } from "../components/command-band.js";
import { setZenMode, setZenTransitionRunner } from "../../integration/zen-mode.js";
import { BrandWordmark } from "./zen-bar.js";

/**
 * Zen 전환 장면 — 반투명 커튼이 내려오는 동안 앰블럼(마크와 워드마크)이 제자리에서 커지며 세로축으로
 * 한 바퀴 뒤집히고, 커튼이 걷히는 동안 새 자리(켤 때는 작업 표시줄 트레이, 끌 때는 Band 왼쪽)로 한 번에
 * 날아가 내려앉는다. 끌 때는 회전 방향만 거꾸로다.
 *
 * 화면 가운데를 거치지 않는 이유: Desktop의 Zen은 네이티브 전체화면과 함께 켜지고 꺼지므로 장면 도중
 * 창 크기가 바뀐다. 제자리 구간은 출발한 모서리(켤 때 왼쪽 위, 끌 때 오른쪽 아래)를 원점으로 삼아
 * 그리므로 창이 커지거나 줄어도 그 모서리에 붙어 있다.
 *
 * 레이아웃 전환(Band·사이드바가 물러나고 작업 표시줄이 올라오는 것)은 커튼이 가린 동안 일어난다.
 * 도착 자리는 전환 뒤에야 서므로 날아가기 직전에 잰다. 측정할 자리가 없거나 동작 줄이기를 켠
 * 환경이면 장면을 맡지 않고, Zen은 곧바로 바뀐다.
 */

/** 제자리에서 커지며 한 바퀴 도는 구간. 끌 때의 전체화면 해제(창 축소)가 이 안에서 끝나도록 넉넉히 둔다. */
const SPIN_MS = 900;
/** 날아가는 시간은 거리에 비례한다 — 900px 창에서 약 640ms, 2560px 전체화면 대각선에서 950ms. */
const FLY_BASE_MS = 480;
const FLY_MS_PER_PX = 0.18;
const FLY_MIN_MS = 560;
const FLY_MAX_MS = 950;
/**
 * 멈춰 돌던 마크가 떠나는 움직임이라 출발 속도가 0인 곡선을 쓴다. 출발이 가장 빠른 스프링 곡선은
 * 긴 대각선에서 첫 프레임에 수백 px을 건너뛰어 순간이동처럼 보인다. 도착은 스프링처럼 길게 감속한다.
 */
const FLY_EASING = "cubic-bezier(0.45, 0, 0.15, 1)";
const VEIL_IN_MS = 320;
/** 켤 때는 커튼이 반쯤 내려온 뒤, 끌 때는 다 내려온 뒤 레이아웃을 바꾼다. */
const SWITCH_AT_MS = { enter: 200, exit: 340 } as const;
const MARK_SIZE = 72;
const WORD_SIZE = 40;
/**
 * 제자리에서 커진 마크의 크기와, 커진 앰블럼이 화면 가장자리에서 떨어지는 여백. 여백은 세로축으로 돌 때
 * 원근 때문에 가까운 쪽 모서리가 부푸는 몫(실측 약 1.5배)까지 담는다.
 */
const GROWN_MARK_SIZE = 64;
const EDGE_MARGIN = 24;
const SPIN_FRAMES = 16;
const FLIGHT_ATTRIBUTE = "zenFlight";

/** 워드마크는 size가 글자 크기, width가 그 크기에서의 폭이다. */
interface Rect { readonly x: number; readonly y: number; readonly size: number; readonly width?: number }
interface BrandRects { readonly mark: Rect; readonly word: Rect }
/** 제자리 구간의 원점 — 켤 때는 왼쪽 위(start), 끌 때는 오른쪽 아래(end) 모서리. */
type Anchor = "start" | "end";

export function ZenTransition({ local = false }: { readonly local?: boolean } = {}) {
  const veilRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const busyRef = useRef(false);

  useEffect(() => setZenTransitionRunner((next) => {
    // 장면이 도는 동안의 요청은 삼킨다 — 반쯤 걸린 커튼 위에서 방향을 바꾸면 어느 쪽도 끝나지 않는다.
    if (busyRef.current) return true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    const veil = veilRef.current, mark = markRef.current, word = wordRef.current;
    // 끌 때 출발 자리(트레이 앰블럼)를 못 재면 모서리 가까이에서 떠오르며 시작한다.
    // 켤 때 출발 자리(밴드 브랜드)를 못 재면 장면 없이 바꾼다.
    const from = next ? measureBandBrand() : measureTaskbarBrand();
    if (veil === null || mark === null || word === null || (from === null && next)) return false;
    busyRef.current = true;
    void play(next, from, { veil, mark, word }).finally(() => { busyRef.current = false; });
    return true;
  }), []);

  return (
    <div className="zen-transition" aria-hidden="true">
      <div className="zen-transition-veil" ref={veilRef} />
      <div className="zen-transition-mark" ref={markRef}><BrandMarkIcon className="zen-transition-mark-glyph" local={local} /></div>
      <BrandWordmark className="zen-transition-wordmark" local={local} ref={wordRef} />
    </div>
  );
}

async function play(next: boolean, from: BrandRects | null, actors: { readonly veil: HTMLElement; readonly mark: HTMLElement; readonly word: HTMLElement }): Promise<void> {
  const { veil, mark, word } = actors;
  const root = document.documentElement;
  const stage = mark.parentElement;
  const anchor: Anchor = next ? "start" : "end";
  const sign = next ? 1 : -1;
  const running: Animation[] = [];
  const track = (animation: Animation) => { running.push(animation); return animation; };
  root.dataset[FLIGHT_ATTRIBUTE] = "true";
  if (stage !== null) stage.dataset.anchor = anchor;
  mark.style.visibility = "visible";
  let switched = false;
  const switchTimer = window.setTimeout(() => {
    switched = true;
    setZenMode(next);
  }, next ? SWITCH_AT_MS.enter : SWITCH_AT_MS.exit);
  try {
    track(veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: VEIL_IN_MS, fill: "forwards" }));

    // 1 — 제자리에서 커지며 세로축으로 한 바퀴. 출발 자리가 없으면(작업 표시줄이 안 보이는 채 끔) 모서리 가까이에서 떠오른다.
    const start = from === null ? null : toLocal(from, anchor);
    const grown = start === null ? cornerMark(anchor) : growInPlace(start, anchor);
    if (start !== null) word.style.visibility = "visible";
    const markFrames: Keyframe[] = [];
    const wordFrames: Keyframe[] = [];
    for (let index = 0; index <= SPIN_FRAMES; index += 1) {
      const progress = index / SPIN_FRAMES;
      const turn = easeInOutCubic(progress);
      const growth = easeOutCubic(Math.min(1, progress * 1.6));
      const markRect = start === null ? grown.mark : lerpRect(start.mark, grown.mark, growth);
      markFrames.push({
        transform: `${markTransform(markRect)} rotateY(${(360 * turn * sign).toFixed(2)}deg)`,
        ...(start === null ? { opacity: Math.min(1, progress * 3) } : {}),
      });
      if (start !== null) wordFrames.push({ transform: wordTransform(lerpRect(start.word, grown.word, growth)) });
    }
    await Promise.all([
      track(mark.animate(markFrames, { duration: SPIN_MS, easing: "linear", fill: "forwards" })).finished,
      ...(start === null ? [] : [track(word.animate(wordFrames, { duration: SPIN_MS, easing: "linear", fill: "forwards" })).finished]),
    ]);

    // 2 — 새 자리로 한 번에 날아가 내려앉는다. 그 자리는 레이아웃 전환 뒤에야 서므로 지금 잰다. 자리가
    //     화면 밖이면 제자리에서 흐려지며 사라진다. 원점이 모서리이므로 도착 자리도 지금 그 모서리 기준으로 옮긴다.
    const measured = next ? measureTaskbarBrand() : measureBandBrand();
    const to = measured === null ? null : toLocal(measured, anchor);
    const spun = `rotateY(${360 * sign}deg)`;
    if (to === null) {
      track(veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MIN_MS, fill: "forwards" }));
      await Promise.all([
        track(mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MIN_MS / 2, fill: "forwards" })).finished,
        track(word.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MIN_MS / 2, fill: "forwards" })).finished,
      ]);
    } else {
      const duration = flightDuration(grown.mark, to.mark);
      track(veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.9, easing: "ease-out", fill: "forwards" }));
      const flights = [
        track(mark.animate([
          { transform: `${markTransform(grown.mark)} ${spun}` },
          { transform: `${markTransform(to.mark)} ${spun}` },
        ], { duration, easing: FLY_EASING, fill: "forwards" })).finished,
      ];
      if (start === null) {
        // 출발 워드마크가 없었으면 도착 자리에서 나타난다.
        word.style.visibility = "visible";
        flights.push(track(word.animate([
          { transform: wordTransform(to.word), opacity: 0 },
          { transform: wordTransform(to.word), opacity: 1 },
        ], { duration, easing: "ease-in", fill: "forwards" })).finished);
      } else {
        flights.push(track(word.animate([
          { transform: wordTransform(grown.word) },
          { transform: wordTransform(to.word) },
        ], { duration, easing: FLY_EASING, fill: "forwards" })).finished);
      }
      await Promise.all(flights);
    }
  } catch {
    // 취소(언마운트·탭 숨김)는 장면만 거둔다.
  } finally {
    window.clearTimeout(switchTimer);
    // 전환이 아직 걸리지 않았을 때만 요청을 마저 반영한다. 이미 걸린 뒤 경로 이탈 같은 강제 종료가
    // Zen을 걷었다면 그 결정을 되돌리지 않는다.
    if (!switched) setZenMode(next);
    for (const animation of running) animation.cancel();
    mark.style.visibility = "";
    word.style.visibility = "";
    if (stage !== null) delete stage.dataset.anchor;
    delete root.dataset[FLIGHT_ATTRIBUTE];
  }
}

function measureBandBrand(): BrandRects | null {
  return measureBrand(".command-band .command-band-brand-glyph", ".command-band .command-band-brand-wordmark");
}

function measureTaskbarBrand(): BrandRects | null {
  return measureBrand(".zen-bar-brand-glyph", ".zen-bar-brand-wordmark");
}

function measureBrand(glyphSelector: string, wordSelector: string): BrandRects | null {
  const glyph = document.querySelector<HTMLElement | SVGElement>(glyphSelector);
  const wordmark = document.querySelector<HTMLElement>(wordSelector);
  if (glyph === null || wordmark === null) return null;
  const glyphRect = glyph.getBoundingClientRect();
  const wordRect = wordmark.getBoundingClientRect();
  if (glyphRect.width === 0 || wordRect.width === 0) return null;
  // 접힌 막대처럼 화면 밖으로 물러난 자리는 착지할 곳이 아니다.
  if (glyphRect.bottom <= 0 || glyphRect.top >= window.innerHeight) return null;
  const fontSize = Number.parseFloat(getComputedStyle(wordmark).fontSize) || 13;
  return {
    mark: { x: glyphRect.left, y: glyphRect.top, size: glyphRect.width },
    // 워드마크는 글자 크기로 줄인다. 줄 높이가 달라도 글자 몸통이 같은 자리에 오도록 세로 가운데를 맞춘다.
    word: { x: wordRect.left, y: wordRect.top + (wordRect.height - fontSize) / 2, size: fontSize, width: wordRect.width },
  };
}

/** 모서리 원점 좌표로 옮긴다. 잰 순간의 창 크기로 옮기므로, 이후 창이 바뀌어도 그 모서리와의 거리가 유지된다. */
function toLocal(rects: BrandRects, anchor: Anchor): BrandRects {
  const originX = anchor === "start" ? 0 : window.innerWidth;
  const originY = anchor === "start" ? 0 : window.innerHeight;
  const shift = (rect: Rect): Rect => ({ ...rect, x: rect.x - originX, y: rect.y - originY });
  return { mark: shift(rects.mark), word: shift(rects.word) };
}

/**
 * 앰블럼(마크+워드마크 한 묶음)을 바깥 모서리를 축으로 키운다 — 켤 때는 왼쪽 위, 끌 때는 오른쪽 아래를
 * 붙든 채 안쪽으로 자라므로 화면 가장자리에 잘리지 않는다. 자란 묶음이 가장자리에 너무 붙으면 여백만큼
 * 안쪽으로 비켜 선다.
 */
function growInPlace(start: BrandRects, anchor: Anchor): BrandRects {
  const scale = GROWN_MARK_SIZE / start.mark.size;
  const wordWidth = start.word.width ?? start.word.size * 3;
  const left = Math.min(start.mark.x, start.word.x);
  const top = Math.min(start.mark.y, start.word.y);
  const right = Math.max(start.mark.x + start.mark.size, start.word.x + wordWidth);
  const bottom = Math.max(start.mark.y + start.mark.size, start.word.y + start.word.size);
  const pivotX = anchor === "start" ? left : right;
  const pivotY = anchor === "start" ? top : bottom;
  const grow = (rect: Rect): Rect => ({
    x: pivotX + (rect.x - pivotX) * scale,
    y: pivotY + (rect.y - pivotY) * scale,
    size: rect.size * scale,
    ...(rect.width === undefined ? {} : { width: rect.width * scale }),
  });
  const mark = grow(start.mark);
  const word = grow(start.word);
  // 모서리 원점 좌표에서 start는 양수, end는 음수 쪽이 화면 안이다.
  const edgeX = anchor === "start" ? Math.max(0, EDGE_MARGIN - pivotX) : Math.min(0, -EDGE_MARGIN - pivotX);
  const edgeY = anchor === "start" ? Math.max(0, EDGE_MARGIN - pivotY) : Math.min(0, -EDGE_MARGIN - pivotY);
  const nudge = (rect: Rect): Rect => ({ ...rect, x: rect.x + edgeX, y: rect.y + edgeY });
  return { mark: nudge(mark), word: nudge(word) };
}

/** 출발 자리를 모를 때 마크 혼자 모서리 가까이에서 떠오를 자리. */
function cornerMark(anchor: Anchor): BrandRects {
  const offset = anchor === "start" ? EDGE_MARGIN : -EDGE_MARGIN - GROWN_MARK_SIZE;
  const mark = { x: offset, y: offset, size: GROWN_MARK_SIZE };
  return { mark, word: mark };
}

function lerpRect(from: Rect, to: Rect, progress: number): Rect {
  const lerp = (a: number, b: number) => a + (b - a) * progress;
  return { x: lerp(from.x, to.x), y: lerp(from.y, to.y), size: lerp(from.size, to.size) };
}

function flightDuration(from: Rect, to: Rect): number {
  const distance = Math.hypot(to.x + to.size / 2 - (from.x + from.size / 2), to.y + to.size / 2 - (from.y + from.size / 2));
  return Math.round(Math.min(FLY_MAX_MS, Math.max(FLY_MIN_MS, FLY_BASE_MS + distance * FLY_MS_PER_PX)));
}

// 마크는 72px 상자의 가운데를 원점으로 줄고 돈다 — 줄여도 상자의 중심이 목표 자리의 중심에 선다.
function markTransform(rect: Rect): string {
  const scale = rect.size / MARK_SIZE;
  const x = rect.x + rect.size / 2 - MARK_SIZE / 2;
  const y = rect.y + rect.size / 2 - MARK_SIZE / 2;
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

// 워드마크는 40px 글자를 왼쪽 위 원점으로 줄인다.
function wordTransform(rect: Rect): string {
  const scale = rect.size / WORD_SIZE;
  return `translate(${rect.x.toFixed(2)}px, ${rect.y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}
