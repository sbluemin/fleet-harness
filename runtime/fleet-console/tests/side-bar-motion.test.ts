// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { observeSideBarCollapseMotion } from "../core/client/src/sidebar/side-bar-motion.js";

const ANIMATING = "data-side-bar-animating";

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  document.body.removeAttribute(ANIMATING);
});

/** jsdom에는 TransitionEvent 생성자가 없다 — 관찰자가 읽는 propertyName만 실은 이벤트로 대신한다. */
function transitionEvent(type: string, propertyName: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  return event;
}

function mountSideBar(): HTMLElement {
  const aside = document.createElement("aside");
  aside.className = "operations-side-bar is-expanded";
  document.body.appendChild(aside);
  return aside;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("side bar collapse motion flag", () => {
  it("raises the flag while the width transition runs and drops it when the transition ends", () => {
    dispose = observeSideBarCollapseMotion();
    const sideBar = mountSideBar();

    sideBar.dispatchEvent(transitionEvent("transitionrun", "width"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(true);

    sideBar.dispatchEvent(transitionEvent("transitionend", "width"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(false);
  });

  it("ignores transitions that are not the side bar's own width", () => {
    dispose = observeSideBarCollapseMotion();
    const sideBar = mountSideBar();
    const other = document.createElement("div");
    other.className = "canvas-operation";
    document.body.appendChild(other);

    sideBar.dispatchEvent(transitionEvent("transitionrun", "border-color"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(false);

    other.dispatchEvent(transitionEvent("transitionrun", "width"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(false);
  });

  it("drops the flag when the transitioning side bar is unmounted mid-transition", async () => {
    dispose = observeSideBarCollapseMotion();
    const sideBar = mountSideBar();

    sideBar.dispatchEvent(transitionEvent("transitionrun", "width"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(true);

    // Map↔War Room 전환은 사이드바 컴포넌트를 통째로 교체한다. 분리된 노드에서 발생하는 종료
    // 이벤트는 document까지 버블링되지 않으므로, 이것이 없으면 플래그가 영구히 남아 패널 모션이
    // 다음 토글까지 죽는다.
    sideBar.remove();
    await nextFrame();
    await nextFrame();

    expect(document.body.hasAttribute(ANIMATING)).toBe(false);
  });

  it("keeps the flag while the side bar is still connected and still transitioning", async () => {
    dispose = observeSideBarCollapseMotion();
    const sideBar = mountSideBar();

    sideBar.dispatchEvent(transitionEvent("transitionrun", "width"));
    await nextFrame();
    await nextFrame();

    expect(document.body.hasAttribute(ANIMATING)).toBe(true);
  });

  it("drops the flag when the observer itself is disposed", () => {
    const stop = observeSideBarCollapseMotion();
    const sideBar = mountSideBar();
    sideBar.dispatchEvent(transitionEvent("transitionrun", "width"));
    expect(document.body.hasAttribute(ANIMATING)).toBe(true);

    stop();
    expect(document.body.hasAttribute(ANIMATING)).toBe(false);
  });
});
