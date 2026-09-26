import { useEffect, useRef } from "react";

import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";
import { runZenWindowStage, setZenMode, setZenTransitionRunner } from "../../integration/zen-mode.js";

/**
 * Zen 전환 장면. 켤 때:
 *
 *   1. 테마 바탕색의 **불투명한** 커튼이 다 쳐진다 — 그 뒤에서 레이아웃이 Zen으로 바뀐다.
 *   2. Band 왼쪽의 앰블럼(마크+워드마크)이 화면 가운데로 옮겨 와 멈춘다. 가운데에서는 아무것도 하지 않는다.
 *   3. 창 단계 — Desktop은 네이티브 전체화면을 켜고 셸의 완료 알림까지 기다린다(브라우저는 곧바로 끝).
 *   4. 가운데에서 세로축으로 한 바퀴 뒤집히며 커졌다 작아진 뒤, 작업 표시줄 오른쪽 끝(트레이 앰블럼)으로
 *      내려앉는 동안 커튼이 걷힌다.
 *
 * 끌 때는 거울상이다: 앰블럼이 트레이에서 가운데로 오는 동안 커튼이 쳐지고, 가운데에서 거꾸로 한 바퀴 돈 뒤
 * 커튼 뒤에서 레이아웃이 돌아오고, 창 단계(전체화면 해제)를 기다린 다음, 앰블럼이 Band 자리로 옮겨 가고
 * 커튼이 걷힌다.
 *
 * 창이 바뀌는 동안 보이는 것은 불투명한 커튼과 멈춘 앰블럼뿐이다 — macOS 전체화면 애니메이션은 창 내용을
 * 얼리므로, 그 사이에 움직이는 것이 있으면 끊겨 보인다. 가운데 배치와 곡선은 Desktop 진입 화면
 * (fleet-desktop/assets/entry)의 넘겨주기를 그대로 쓴다 — 72px 마크와 40px 워드마크, 스프링
 * cubic-bezier(0.16, 1, 0.3, 1). 끌 때 애니메이션을 통째로 역재생하면 곡선까지 뒤집혀 도착이 가속하므로,
 * 경로만 뒤집고 곡선은 그대로 둔다. 도착 자리는 레이아웃·창 전환 뒤에야 서므로 그 구간을 시작할 때 잰다.
 * 측정할 자리가 없거나 동작 줄이기를 켠 환경이면 장면을 맡지 않고, Zen은 곧바로 바뀐다.
 */

/** 커튼이 다 쳐지거나 걷히는 시간(Band 쪽 끝). */
const VEIL_MS = 320;
/** Band 자리 ↔ 가운데. */
const MOVE_MS = 420;
/** 가운데에서의 한 바퀴. */
const SPIN_MS = 700;
/** 가운데 ↔ 트레이 자리. 이 구간 동안 커튼이 걷히거나(켤 때) 쳐진다(끌 때). */
const LAND_MS = 520;
/**
 * 커튼 뒤에서 레이아웃이 돌아온 뒤 Band가 제자리에 서기까지(layout.css의 --duration-base 220ms 전이 + 여유).
 * 창 단계가 곧바로 끝나는 브라우저에서도 착지할 Band 자리를 잴 수 있게 적어도 이만큼은 기다린다.
 */
const BAND_SETTLE_MS = 280;
const SPRING = "cubic-bezier(0.16, 1, 0.3, 1)";
const MARK_SIZE = 72;
const WORD_SIZE = 40;
const SPIN_SCALE_PEAK = 0.28;
const SPIN_FRAMES = 12;
const FLIGHT_ATTRIBUTE = "zenFlight";

/**
 * 배우의 좌표는 화면 **중심**을 원점으로 한다(배우는 CSS로 화면 한가운데에 서 있다). 창이 전체화면으로
 * 커지거나 줄어도 가운데에 멈춰 선 앰블럼이 그대로 가운데에 남는다 — 왼쪽 위 원점이면 창이 커진 뒤 옛 창의
 * 가운데, 곧 새 화면의 왼쪽 위에서 돌게 된다. 자리를 잰 값은 잰 순간의 창 크기로 옮겨 둔다.
 */
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
  // 배우를 곧바로 한 자리에 세운다(0ms 애니메이션 + forwards). 다음 구간의 애니메이션이 이어받는다.
  const place = (markRect: Rect, wordRect: Rect, opacity = 1) => {
    track(mark.animate([{ transform: markTransform(markRect), opacity }], { duration: 0, fill: "forwards" }));
    track(word.animate([{ transform: wordTransform(wordRect), opacity }], { duration: 0, fill: "forwards" }));
  };
  const moveBetween = (a: BrandRects, b: BrandRects) => Promise.all([
    track(mark.animate([{ transform: markTransform(a.mark) }, { transform: markTransform(b.mark) }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
    track(word.animate([{ transform: wordTransform(a.word) }, { transform: wordTransform(b.word) }], { duration: MOVE_MS, easing: SPRING, fill: "forwards" })).finished,
  ]);
  // 가운데에서의 한 바퀴 — 도는 동안 1.0 → 1.28 → 1.0으로 커졌다 작아진다.
  const spin = () => {
    const spinFrames: Keyframe[] = [];
    for (let index = 0; index <= SPIN_FRAMES; index += 1) {
      const eased = easeInOutCubic(index / SPIN_FRAMES);
      const scale = 1 + SPIN_SCALE_PEAK * Math.sin(Math.PI * eased);
      spinFrames.push({ transform: `${markTransform(center.mark, scale)} rotateY(${(360 * eased * sign).toFixed(2)}deg)` });
    }
    return Promise.all([
      track(mark.animate(spinFrames, { duration: SPIN_MS, easing: "linear", fill: "forwards" })).finished,
      track(word.animate([
        { transform: wordTransform(center.word) },
        { transform: wordTransform(center.word, 1.06), easing: "ease-in-out" },
        { transform: wordTransform(center.word) },
      ], { duration: SPIN_MS, easing: "ease-in-out", fill: "forwards" })).finished,
    ]);
  };
  // 가운데 ↔ 트레이 — 자리가 없으면(막대를 접어 둠) 가운데에서 나타나거나 사라진다.
  const land = (tray: BrandRects | null, towardTray: boolean) => {
    if (tray === null) {
      const frames = towardTray ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }];
      return Promise.all([
        track(mark.animate(frames, { duration: LAND_MS / 2, fill: "forwards" })).finished,
        track(word.animate(frames, { duration: LAND_MS / 2, fill: "forwards" })).finished,
      ]);
    }
    const spun = `rotateY(${360 * sign}deg)`;
    const atCenter = { mark: `${markTransform(center.mark)} ${towardTray ? spun : ""}`, word: wordTransform(center.word) };
    const atTray = { mark: `${markTransform(tray.mark)} ${towardTray ? spun : ""}`, word: wordTransform(tray.word) };
    const [markFrom, markTo] = towardTray ? [atCenter.mark, atTray.mark] : [atTray.mark, atCenter.mark];
    const [wordFrom, wordTo] = towardTray ? [atCenter.word, atTray.word] : [atTray.word, atCenter.word];
    return Promise.all([
      track(mark.animate([{ transform: markFrom }, { transform: markTo }], { duration: LAND_MS, easing: SPRING, fill: "forwards" })).finished,
      track(word.animate([{ transform: wordFrom }, { transform: wordTo }], { duration: LAND_MS, easing: SPRING, fill: "forwards" })).finished,
    ]);
  };
  const veilTo = (opacity: number, duration: number, easing: string) =>
    track(veil.animate([{ opacity: opacity === 1 ? 0 : 1 }, { opacity }], { duration, easing, fill: "forwards" })).finished;

  root.dataset[FLIGHT_ATTRIBUTE] = "true";
  mark.style.visibility = "visible";
  word.style.visibility = "visible";
  let switched = false;
  const switchLayout = () => {
    switched = true;
    setZenMode(next);
  };
  try {
    if (next) {
      // 1 — 앰블럼은 Band 자리에 선 채 불투명한 커튼이 다 쳐지고, 그 뒤에서 레이아웃이 Zen으로 바뀐다.
      if (from !== null) place(from.mark, from.word);
      await veilTo(1, VEIL_MS, "ease-out");
      switchLayout();
      // 2 — 가운데로 옮겨 와 멈춘다.
      if (from !== null) await moveBetween(from, center);
      // 3 — 창 단계(Desktop 전체화면). 앰블럼은 가운데에 멈춰 있다.
      await runZenWindowStage(true);
      // 4 — 가운데에서 한 바퀴, 트레이로 내려앉으며 커튼이 걷힌다.
      await spin();
      const tray = measureTaskbarBrand();
      await Promise.all([land(tray, true), veilTo(0, LAND_MS * 0.9, "ease-in")]);
    } else {
      // 4′ — 트레이에서 가운데로 오는 동안 커튼이 쳐진다(자리가 없으면 가운데에서 나타난다).
      if (from !== null) place(from.mark, from.word);
      else place(center.mark, center.word, 0);
      await Promise.all([land(from, false), veilTo(1, LAND_MS, "ease-out")]);
      // 가운데에서 거꾸로 한 바퀴 — 끝나면 커튼 뒤에서 레이아웃이 돌아온다.
      await spin();
      switchLayout();
      // 3′ — 창 단계(Desktop 전체화면 해제). 앰블럼은 가운데에 멈춰 있다. Band가 제자리에 설 시간도 함께 기다린다.
      await Promise.all([runZenWindowStage(false), delay(BAND_SETTLE_MS)]);
      // 2′·1′ — 창이 돌아온 뒤의 Band 자리로 옮겨 가고, 커튼이 걷힌다.
      const band = measureBandBrand();
      if (band !== null) await moveBetween(center, band);
      await veilTo(0, VEIL_MS, "ease-in");
    }
  } catch {
    // 취소(언마운트·탭 숨김)는 장면만 거둔다.
  } finally {
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
  const originX = window.innerWidth / 2;
  const originY = window.innerHeight / 2;
  return {
    mark: { x: glyphRect.left - originX, y: glyphRect.top - originY, size: glyphRect.width },
    // 워드마크는 글자 크기로 줄인다. 줄 높이가 달라도 글자 몸통이 같은 자리에 오도록 세로 가운데를 맞춘다.
    word: { x: wordRect.left - originX, y: wordRect.top + (wordRect.height - fontSize) / 2 - originY, size: fontSize },
  };
}

// Desktop 진입 화면의 가운데 배치 — 마크 위, 워드마크 아래.
function centerRects(word: HTMLElement): BrandRects {
  const previous = word.style.transform;
  word.style.transform = "none";
  const wordWidth = word.getBoundingClientRect().width;
  word.style.transform = previous;
  return {
    mark: { x: -MARK_SIZE / 2, y: -116, size: MARK_SIZE },
    word: { x: -wordWidth / 2, y: -26, size: WORD_SIZE },
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}
