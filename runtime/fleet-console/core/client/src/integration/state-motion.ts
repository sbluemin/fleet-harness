interface MotionPreferences {
  readonly reduceMotion: boolean;
  readonly lowerUnfocusedFrameRate: boolean;
}

/** 무한 모션만 저프레임으로 바꾸고, 꺼지면 원래 CSS timing과 시계로 돌아간다. */
export function observeStateMotion(preferences: MotionPreferences): () => void {
  const root = document.documentElement;
  const originals = new WeakMap<Animation, { timing: OptionalEffectTiming; startTime: Animation["startTime"] }>();
  const pending = new WeakSet<Animation>();
  let stopped = false;
  const apply = (animation: Animation) => {
    if (stopped || !(animation instanceof CSSAnimation) || !(animation.effect instanceof KeyframeEffect)) return;
    const effect = animation.effect;
    const original = originals.get(animation);
    if (root.dataset.stateMotion !== "stepped") {
      if (original) {
        effect.updateTiming(original.timing);
        if (animation.playState !== "paused") animation.startTime = original.startTime;
        originals.delete(animation);
      }
      return;
    }
    const timing = effect.getTiming();
    if (original || animation.playState !== "running" || timing.iterations !== Infinity || typeof timing.duration !== "number" || timing.duration <= 0) return;
    // CSS가 막 생긴 시각은 아직 pending일 수 있다. 자연 시작 시각을 확정한 뒤에 보관한다.
    if (animation.startTime === null) {
      if (!pending.has(animation)) {
        pending.add(animation);
        void animation.ready.then(() => { pending.delete(animation); apply(animation); }, () => { pending.delete(animation); });
      }
      return;
    }
    originals.set(animation, { timing: { duration: timing.duration, delay: timing.delay, easing: timing.easing }, startTime: animation.startTime });
    effect.updateTiming(steppedTiming(timing.duration, timing.delay ?? 0));
    // 문서 원점(0)이 아니라 가까운 100ms 칸으로 맞춘다 — 늦게 생긴 애니메이션의 지연(delay)이 살아 있어야 한다.
    animation.startTime = Math.round(Number(animation.startTime) / 100) * 100;
  };
  // updateTiming으로 덮은 속성은 이후 CSS 변경을 받지 않는다. 같은 이름의 주기가 CSS에서 바뀌면
  // (예: 마스코트 날갯짓이 비행·잡힘에서 빨라짐) 반복 경계에서 새 CSS 값으로 다시 덮는다.
  const resync = (animation: Animation) => {
    if (!(animation instanceof CSSAnimation) || !(animation.effect instanceof KeyframeEffect)) return;
    const effect = animation.effect;
    const original = originals.get(animation);
    if (!original || !effect.target) return;
    const css = cssTiming(getComputedStyle(effect.target, effect.pseudoElement), animation.animationName);
    if (!css || (css.duration === original.timing.duration && css.delay === original.timing.delay)) return;
    originals.set(animation, { ...original, timing: { ...original.timing, duration: css.duration, delay: css.delay } });
    effect.updateTiming(steppedTiming(css.duration, css.delay));
  };
  // updateTiming의 override를 값만 되돌리면 이후 CSS 주기 변경을 가린다. 무한 항목만 다시
  // CSS에 연결하고 원래 시각을 돌려준다 — 혼합 목록의 일회성 등장 효과는 none gate 밖이다.
  const restore = () => {
    const phases = new WeakMap<Element, Map<string, { startTime: Animation["startTime"]; currentTime: Animation["currentTime"]; paused: boolean }>>();
    const records = document.getAnimations().filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.effect instanceof KeyframeEffect && animation.effect.getTiming().iterations === Infinity);
    for (const animation of records) {
      const effect = animation.effect as KeyframeEffect;
      if (!effect.target) continue;
      const entries = phases.get(effect.target) ?? new Map();
      entries.set(`${animation.animationName}:${effect.pseudoElement ?? ""}`, { startTime: originals.get(animation)?.startTime ?? animation.startTime, currentTime: animation.currentTime, paused: animation.playState === "paused" });
      phases.set(effect.target, entries);
    }
    root.dataset.stateMotion = "inactive";
    const retained = new Set(document.getAnimations());
    for (const animation of records) {
      const original = originals.get(animation);
      if (original && retained.has(animation)) {
        animation.effect?.updateTiming(original.timing);
        if (animation.playState !== "paused") animation.startTime = original.startTime;
      }
      originals.delete(animation);
    }
    root.dataset.stateMotion = "smooth";
    for (const animation of document.getAnimations()) {
      if (!(animation instanceof CSSAnimation) || !(animation.effect instanceof KeyframeEffect) || !animation.effect.target || retained.has(animation)) continue;
      const phase = phases.get(animation.effect.target)?.get(`${animation.animationName}:${animation.effect.pseudoElement ?? ""}`);
      if (!phase) continue;
      if (phase.paused) animation.currentTime = phase.currentTime;
      else animation.startTime = phase.startTime;
    }
  };
  let blurCheck: ReturnType<typeof setTimeout> | null = null;
  const update = () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    blurCheck = null;
    const next = document.visibilityState !== "visible" ? "inactive"
      : preferences.reduceMotion || (preferences.lowerUnfocusedFrameRate && !document.hasFocus()) ? "stepped" : "smooth";
    if (next === "smooth" && root.dataset.stateMotion === "stepped") restore();
    if (root.dataset.stateMotion !== next) root.dataset.stateMotion = next;
    for (const animation of document.getAnimations()) apply(animation);
  };
  const blurred = () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    blurCheck = setTimeout(update, 0);
  };
  const start = (event: AnimationEvent) => {
    if (event.target instanceof Element) {
      for (const animation of event.target.getAnimations({ subtree: true })) apply(animation);
    }
  };
  const iterated = (event: AnimationEvent) => {
    if (root.dataset.stateMotion !== "stepped" || !(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.animationName === event.animationName) resync(animation);
    }
  };
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", blurred);
  document.addEventListener("visibilitychange", update);
  document.addEventListener("animationstart", start);
  document.addEventListener("animationiteration", iterated);
  return () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", blurred);
    document.removeEventListener("visibilitychange", update);
    document.removeEventListener("animationstart", start);
    document.removeEventListener("animationiteration", iterated);
    if (root.dataset.stateMotion === "stepped") restore();
    delete root.dataset.stateMotion;
    for (const animation of document.getAnimations()) apply(animation);
    stopped = true;
  };
}

function steppedTiming(duration: number, delay: number): OptionalEffectTiming {
  const ticks = Math.max(1, Math.round(duration / 100));
  return { duration: ticks * 100, delay: Math.round(delay / 100) * 100, easing: `steps(${ticks}, end)` };
}

/** 계산된 animation 목록에서 이름이 같은 항목의 주기·지연(ms)을 읽는다. 목록이 짧으면 CSS처럼 반복한다. */
function cssTiming(style: CSSStyleDeclaration, name: string): { duration: number; delay: number } | null {
  const index = style.animationName.split(",").map((item) => item.trim()).indexOf(name);
  if (index < 0) return null;
  const pick = (list: string) => {
    const items = list.split(",");
    const value = items[index % items.length]!.trim();
    return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
  };
  const duration = pick(style.animationDuration);
  const delay = pick(style.animationDelay);
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(delay) ? { duration, delay } : null;
}
