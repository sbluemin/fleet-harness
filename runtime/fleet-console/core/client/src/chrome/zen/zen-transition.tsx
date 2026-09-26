import { useEffect, useRef } from "react";

import { BrandMarkIcon } from "../components/command-band.js";
import { setZenMode, setZenTransitionRunner } from "../../integration/zen-mode.js";
import { BrandWordmark } from "./zen-bar.js";

/**
 * Zen 전환 장면 — 반투명 커튼이 내려오고, Band 왼쪽의 앰블럼과 워드마크가 화면 가운데로 나와
 * 세로축으로 한 바퀴 뒤집히며 커졌다 작아진 뒤, 커튼이 걷히는 동안 작업 표시줄 오른쪽 끝(Zen 바
 * 트레이의 앰블럼)에 내려앉는다. 끌 때는 경로와 회전 방향만 거꾸로 돈다.
 *
 * 곡선과 가운데 배치는 Desktop 진입 화면(fleet-desktop/assets/entry)의 넘겨주기를 그대로 쓴다 —
 * 72px 마크와 40px 워드마크, 420ms, cubic-bezier(0.16, 1, 0.3, 1). 끌 때 애니메이션을 통째로
 * 역재생하면 곡선까지 뒤집혀 도착이 가속하므로, 종료 인사처럼 경로만 뒤집고 곡선은 그대로 둔다.
 *
 * 레이아웃 전환(Band·사이드바가 물러나고 작업 표시줄이 올라오는 것)은 커튼이 가린 동안 일어난다.
 * 도착 자리는 전환 뒤에야 서므로 마지막 구간을 시작할 때 잰다. 측정할 자리가 없거나 동작 줄이기를
 * 켠 환경이면 장면을 맡지 않고, Zen은 곧바로 바뀐다.
 */

const MOVE_MS = 420;
const SPIN_MS = 700;
const LAND_MS = 520;
const TOTAL_MS = MOVE_MS + SPIN_MS + LAND_MS;
/** 켤 때는 커튼이 반쯤 내려온 뒤, 끌 때는 다 내려온 뒤 레이아웃을 바꾼다. */
const SWITCH_AT = { enter: 0.12, exit: 0.34 } as const;
const SPRING = "cubic-bezier(0.16, 1, 0.3, 1)";
const MARK_SIZE = 72;
const WORD_SIZE = 40;
const SPIN_SCALE_PEAK = 0.28;
const SPIN_FRAMES = 12;
const FLIGHT_ATTRIBUTE = "zenFlight";

interface Rect { readonly x: number; readonly y: number; readonly size: number }
interface BrandRects { readonly mark: Rect; readonly word: Rect }

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
    // 막대를 접어 둔 채 끄면 출발 자리(막대 끝)가 화면 밖이다 — 그때는 가운데에서 떠오르며 시작한다.
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
  const center = centerRects(word);
  const sign = next ? 1 : -1;
  const running: Animation[] = [];
  const track = (animation: Animation) => { running.push(animation); return animation; };
  root.dataset[FLIGHT_ATTRIBUTE] = "true";
  mark.style.visibility = "visible";
  word.style.visibility = "visible";
  let switched = false;
  const switchTimer = window.setTimeout(() => {
    switched = true;
    setZenMode(next);
  }, TOTAL_MS * (next ? SWITCH_AT.enter : SWITCH_AT.exit));
  try {
    track(veil.animate([
      { offset: 0, opacity: 0 },
      { offset: 0.2, opacity: 1 },
      { offset: (MOVE_MS + SPIN_MS) / TOTAL_MS, opacity: 1 },
      { offset: 0.95, opacity: 0 },
      { offset: 1, opacity: 0 },
    ], { duration: TOTAL_MS, fill: "both" }));

    // 1 — 제자리에서 가운데로(Desktop 넘겨주기의 역방향 배치). 출발 자리가 화면 밖이면 가운데에서 떠오른다.
    await Promise.all(from === null
      ? [
        track(mark.animate([{ transform: markTransform(center.mark), opacity: 0 }, { transform: markTransform(center.mark), opacity: 1 }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
        track(word.animate([{ transform: wordTransform(center.word), opacity: 0 }, { transform: wordTransform(center.word), opacity: 1 }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
      ]
      : [
        track(mark.animate([{ transform: markTransform(from.mark) }, { transform: markTransform(center.mark) }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
        track(word.animate([{ transform: wordTransform(from.word) }, { transform: wordTransform(center.word) }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
      ]);

    // 2 — 세로축으로 한 바퀴. 도는 동안 1.0 → 1.28 → 1.0으로 커졌다 작아진다.
    const spinFrames: Keyframe[] = [];
    for (let index = 0; index <= SPIN_FRAMES; index += 1) {
      const eased = easeInOutCubic(index / SPIN_FRAMES);
      const scale = 1 + SPIN_SCALE_PEAK * Math.sin(Math.PI * eased);
      spinFrames.push({ transform: `${markTransform(center.mark, scale)} rotateY(${(360 * eased * sign).toFixed(2)}deg)` });
    }
    await Promise.all([
      track(mark.animate(spinFrames, { duration: SPIN_MS, easing: "linear", fill: "forwards" })).finished,
      track(word.animate([
        { transform: wordTransform(center.word) },
        { transform: wordTransform(center.word, 1.06), easing: "ease-in-out" },
        { transform: wordTransform(center.word) },
      ], { duration: SPIN_MS, easing: "ease-in-out", fill: "forwards" })).finished,
    ]);

    // 3 — 새 자리로 내려앉는다. 그 자리는 레이아웃 전환 뒤에야 서므로 지금 잰다. 막대를 접어 둬서
    //     자리가 화면 밖이면 가운데에서 흐려지며 사라진다.
    const to = next ? measureTaskbarBrand() : measureBandBrand();
    if (to === null) {
      await Promise.all([
        track(mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LAND_MS / 2, fill: "forwards" })).finished,
        track(word.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LAND_MS / 2, fill: "forwards" })).finished,
      ]);
    } else {
      await Promise.all([
        track(mark.animate([{ transform: `${markTransform(center.mark)} rotateY(${360 * sign}deg)` }, { transform: `${markTransform(to.mark)} rotateY(${360 * sign}deg)` }], { duration: LAND_MS, easing: SPRING, fill: "forwards" })).finished,
        track(word.animate([{ transform: wordTransform(center.word) }, { transform: wordTransform(to.word) }], { duration: LAND_MS, easing: SPRING, fill: "forwards" })).finished,
      ]);
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
    word: { x: wordRect.left, y: wordRect.top + (wordRect.height - fontSize) / 2, size: fontSize },
  };
}

// Desktop 진입 화면의 가운데 배치 — 마크 위, 워드마크 아래.
function centerRects(word: HTMLElement): BrandRects {
  const previous = word.style.transform;
  word.style.transform = "none";
  const wordWidth = word.getBoundingClientRect().width;
  word.style.transform = previous;
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  return {
    mark: { x: centerX - MARK_SIZE / 2, y: centerY - 116, size: MARK_SIZE },
    word: { x: centerX - wordWidth / 2, y: centerY - 26, size: WORD_SIZE },
  };
}

// 마크는 72px 상자의 가운데를 원점으로 줄고 돈다 — 줄여도 상자의 중심이 목표 자리의 중심에 선다.
function markTransform(rect: Rect, extraScale = 1): string {
  const scale = (rect.size / MARK_SIZE) * extraScale;
  const x = rect.x + rect.size / 2 - MARK_SIZE / 2;
  const y = rect.y + rect.size / 2 - MARK_SIZE / 2;
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

// 워드마크는 40px 글자를 왼쪽 위 원점으로 줄인다.
function wordTransform(rect: Rect, extraScale = 1): string {
  const scale = (rect.size / WORD_SIZE) * extraScale;
  return `translate(${rect.x.toFixed(2)}px, ${rect.y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}
