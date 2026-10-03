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
    const ticks = Math.max(1, Math.round(timing.duration / 100));
    effect.updateTiming({ duration: ticks * 100, delay: Math.round((timing.delay ?? 0) / 100) * 100, easing: `steps(${ticks}, end)` });
    animation.startTime = 0;
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
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", blurred);
  document.addEventListener("visibilitychange", update);
  document.addEventListener("animationstart", start);
  return () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", blurred);
    document.removeEventListener("visibilitychange", update);
    document.removeEventListener("animationstart", start);
    if (root.dataset.stateMotion === "stepped") restore();
    delete root.dataset.stateMotion;
    for (const animation of document.getAnimations()) apply(animation);
    stopped = true;
  };
}
