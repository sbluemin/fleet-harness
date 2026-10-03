/** 상태 모션은 창의 수명에 묶고, 같은 주기의 표시들은 문서 시계의 같은 칸에서 움직인다. */
export function observeStateMotion(): () => void {
  const root = document.documentElement;
  const aligned = new WeakSet<Animation>();
  const align = (element: Element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      const effect = animation.effect;
      if (!(animation instanceof CSSAnimation) || !(effect instanceof KeyframeEffect) || effect.getTiming().iterations !== Infinity || aligned.has(animation)) continue;
      if (!effect.target || getComputedStyle(effect.target, effect.pseudoElement).getPropertyValue("--state-motion-clock").trim() !== "aligned") continue;
      if (!effect.getKeyframes().some((frame) => frame.easing.startsWith("steps("))) continue;
      animation.startTime = 0;
      aligned.add(animation);
    }
  };
  let blurCheck: ReturnType<typeof setTimeout> | null = null;
  const update = () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    blurCheck = null;
    const next = document.visibilityState === "visible" && document.hasFocus() ? "active" : "inactive";
    if (root.dataset.stateMotion !== next) root.dataset.stateMotion = next;
  };
  const blurred = () => {
    if (blurCheck !== null) clearTimeout(blurCheck);
    blurCheck = setTimeout(update, 0);
  };
  const start = (event: AnimationEvent) => {
    if (event.target instanceof Element) align(event.target);
  };
  update();
  for (const animation of document.getAnimations()) {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (target) align(target);
  }
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
    delete root.dataset.stateMotion;
  };
}
