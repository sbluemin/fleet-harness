// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { EffortTrack, effortLadderPosition, resolveRowEffort } from "../core/client/src/components/effort-track.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

const AXIS = ["low", "medium", "high", "xhigh", "max"] as const;

function row(overrides: Partial<OperationLaunchVariantRow> = {}): OperationLaunchVariantRow {
  return {
    id: "kimi--k3",
    label: "K3-1M",
    launch: { model: "kimi--k3" },
    effortAxis: [...AXIS],
    chips: ["low", "high", "max"].map((id) => ({
      id,
      label: id.toUpperCase(),
      launch: { model: "kimi--k3", effort: id },
    })),
    ...overrides,
  };
}

function render(
  node: OperationLaunchVariantRow,
  value: string | null,
  onChange = vi.fn(),
  onConfirmCurrent?: () => void,
) {
  act(() => root.render(
    <EffortTrack
      row={node}
      value={value}
      onChange={onChange}
      onConfirmCurrent={onConfirmCurrent}
      autoLabel="AUTO"
      ariaLabel="Reasoning effort"
      autoValueText="Automatic"
      apexToggleLabel="Show Max and Ultracode"
    />,
  ));
  return onChange;
}

function stubTrackPointer(width = 126) {
  const element = track();
  let captured: number | null = null;
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 0, right: width, top: 0, bottom: 26, width, height: 26, x: 0, y: 0, toJSON: () => ({}) }),
    },
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => { captured = pointerId; },
    },
    releasePointerCapture: {
      configurable: true,
      value: () => { captured = null; },
    },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured === pointerId,
    },
  });
  return element;
}

function stops(): readonly HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".effort-track-stop"));
}

function track(): HTMLElement {
  return required(".effort-track");
}

function fill(): HTMLElement {
  return required(".effort-track-fill");
}

function value(): HTMLElement {
  return required(".effort-track-value");
}

function required(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected ${selector}`);
  return element;
}

describe("EffortTrack", () => {
  it("keeps every rung of the canonical axis, so an offered rung sits where it belongs", () => {
    render(row(), null);

    // AUTO + 5단 축. low/high/max만 고를 수 있고 medium·xhigh는 자리만 지킨다 —
    // 셋을 균등히 벌리면 high가 한가운데 서서 3/5 지점인 단을 절반이라고 말하게 된다.
    const marks = stops();
    expect(marks).toHaveLength(6);
    expect(marks.map((mark) => mark.dataset.gap ?? null)).toEqual([null, null, "true", null, "true", null]);
    expect(marks[3]!.style.left).toBe("60%");
  });

  it("falls back to the offered rungs when the row carries no axis", () => {
    render(row({ effortAxis: undefined }), null);

    expect(stops()).toHaveLength(4);
    expect(stops().every((mark) => mark.dataset.gap === undefined)).toBe(true);
    expect(document.querySelector<HTMLElement>(".effort-track")?.dataset.atMax).toBeUndefined();
  });

  it("opens on the empty rung and reports it as the model's own default", () => {
    render(row(), null);

    expect(track().getAttribute("aria-valuenow")).toBe("0");
    expect(track().getAttribute("aria-valuetext")).toBe("Automatic");
    expect(document.querySelector(".effort-track-value")?.textContent).toBe("AUTO");
    expect(document.querySelector<HTMLElement>(".effort-track-value")?.dataset.auto).toBe("true");
  });

  it("leaves the empty rung unfilled so it cannot read as the lowest rung", () => {
    render(row(), null);

    // 손잡이 여백만큼이라도 채우면 트랙 왼쪽 끝에 brass 조각이 남아 최소 단을 고른 것처럼 보인다.
    expect(fill().style.width).toBe("0px");
    expect(track().dataset.auto).toBe("true");
    expect(document.querySelector<HTMLElement>(".effort-track-knob")?.dataset.auto).toBe("true");
    // 축 위의 어느 점도 채워지지 않는다.
    expect(stops().every((mark) => mark.dataset.filled === undefined)).toBe(true);

    render(row(), "low");
    expect(fill().style.width).not.toBe("0px");
    expect(track().dataset.auto).toBeUndefined();
    expect(document.querySelector<HTMLElement>(".effort-track-knob")?.dataset.auto).toBeUndefined();
  });

  it("names the rung it stands on so the value label can take its own tone", () => {
    render(row(), null);
    expect(value().dataset.effortLevel).toBe("auto");

    for (const rung of ["low", "high", "max"]) {
      render(row(), rung);
      expect(value().dataset.effortLevel).toBe(rung);
    }
  });

  it("steps over rungs the model does not offer", () => {
    const onChange = render(row(), "low");

    // low(1) 다음 고를 수 있는 단은 medium(2)이 아니라 high(3)다.
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("high");

    onChange.mockClear();
    render(row(), "high", onChange);
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("low");
  });

  it("reaches the empty rung with Home and the top rung with End", () => {
    const onChange = render(row(), "high");

    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("max");

    onChange.mockClear();
    render(row(), "high", onChange);
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps arrow keys from reaching the menu it lives in", () => {
    const onMenuKey = vi.fn();
    document.body.addEventListener("keydown", onMenuKey);
    render(row(), "low");

    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    // 위로 새면 메뉴가 항목 이동으로 받아 트랙과 함께 움직인다.
    expect(onMenuKey).not.toHaveBeenCalled();

    // Escape는 트랙이 다루지 않는다 — 서브메뉴를 닫는 것은 메뉴의 일이다.
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onMenuKey).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("keydown", onMenuKey);
  });

  it("previews the selectable rung that a pointer action would choose", () => {
    const onChange = render(row(), "low");
    Object.defineProperties(track(), {
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, right: 126, top: 0, bottom: 26, width: 126, height: 26, x: 0, y: 0, toJSON: () => ({}) }),
      },
      hasPointerCapture: { configurable: true, value: () => false },
    });

    // medium(2) 자리를 가리켜도 이 모델이 실제로 고를 수 있는 가까운 low(1)를 비춘다.
    act(() => track().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 53 })));
    expect(stops().map((mark) => mark.dataset.previewed ?? null)).toEqual([null, "true", null, null, null, null]);
    expect(onChange).not.toHaveBeenCalled();

    // high(3)은 선택 가능하므로 그 자리 자체가 preview다.
    act(() => track().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 73 })));
    expect(stops().map((mark) => mark.dataset.previewed ?? null)).toEqual([null, null, null, "true", null, null]);
    expect(onChange).not.toHaveBeenCalled();

    act(() => track().dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
    expect(stops().every((mark) => mark.dataset.previewed === undefined)).toBe(true);
  });

  it("marks only the top rung as the one at maximum", () => {
    render(row(), "max");
    expect(track().dataset.atMax).toBe("true");

    render(row(), "high");
    expect(track().dataset.atMax).toBeUndefined();

    // 비운 상태는 축의 맨 앞이지 최대가 아니다.
    render(row({ chips: [] }), null);
    expect(track().dataset.atMax).toBeUndefined();
  });

  it("confirms the current rung on re-press when onConfirmCurrent is set", () => {
    const onChange = vi.fn();
    const onConfirmCurrent = vi.fn();
    render(row(), "high", onChange, onConfirmCurrent);
    const element = stubTrackPointer();

    // high(3) 자리: EDGE 13 + 0.6 × (126 − 26) = 73. 같은 단을 다시 누르면 값이 아니라 확정이다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onConfirmCurrent).toHaveBeenCalledTimes(1);

    onConfirmCurrent.mockClear();
    act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onConfirmCurrent).toHaveBeenCalledTimes(1);
  });

  it("does not confirm when the pointer first moves to another rung", () => {
    const onChange = vi.fn();
    const onConfirmCurrent = vi.fn();
    render(row(), "high", onChange, onConfirmCurrent);
    const element = stubTrackPointer();

    // high → max로 옮긴 뒤 손을 떼면 값만 바뀌고 확정은 없다 — 그 제스처는 "고르기"다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
    });
    expect(onChange).toHaveBeenCalledWith("max");
    expect(onConfirmCurrent).not.toHaveBeenCalled();
  });

  it("does not confirm a secondary-button release or a release outside the track", () => {
    const onChange = vi.fn();
    const onConfirmCurrent = vi.fn();
    render(row(), "high", onChange, onConfirmCurrent);
    const element = stubTrackPointer();

    // 우클릭은 X가 같은 단이어도 확정이 아니다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 2, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, button: 2, isPrimary: true, clientX: 73, clientY: 13 }));
    });
    expect(onConfirmCurrent).not.toHaveBeenCalled();

    // 세로로 트랙 밖에서 손을 떼면 같은 X라도 확정하지 않는다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3, button: 0, isPrimary: true, clientX: 73, clientY: 40 }));
    });
    expect(onConfirmCurrent).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a second contact while the first gesture is active", () => {
    const onChange = vi.fn();
    const onConfirmCurrent = vi.fn();
    render(row(), "high", onChange, onConfirmCurrent);
    const element = stubTrackPointer();

    // 첫 손가락은 잡고, 두 번째(비-primary)가 같은 단에서 떼어도 확정하지 않는다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 0, isPrimary: false, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, button: 0, isPrimary: false, clientX: 73, clientY: 13 }));
    });
    expect(onConfirmCurrent).not.toHaveBeenCalled();

    // 시작한 포인터를 같은 단에서 떼면 그때 확정한다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
    });
    expect(onConfirmCurrent).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves same-rung re-press quiet when onConfirmCurrent is omitted", () => {
    const onChange = vi.fn();
    render(row(), "high", onChange);
    const element = stubTrackPointer();

    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 73, clientY: 13 }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides gated stops behind the apex toggle", () => {
    render(row({ gatedEfforts: ["max", "ultra"] }), "high");

    const toggle = required(".effort-track-apex-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show Max and Ultracode");
    expect(stops()).toHaveLength(5);
    expect(document.querySelector("[data-apex-rung=true]")).toBeNull();
    expect(track().getAttribute("aria-valuemax")).toBe("4");
  });

  it("reveals gated stops and extends the slider range when toggled", () => {
    render(row({
      effortAxis: [...AXIS, "ultra"],
      chips: [...row().chips!, { id: "ultra", label: "ULTRA", launch: { model: "kimi--k3", effort: "ultra" } }],
      gatedEfforts: ["max", "ultra"],
    }), "high");

    act(() => required(".effort-track-apex-toggle").click());
    expect(required(".effort-track-apex-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-apex-rung=true]")).toHaveLength(2);
    expect(track().getAttribute("aria-valuemax")).toBe("6");
  });

  it("marks a selected gated rung as apex and maximum", () => {
    const gatedRow = row({ gatedEfforts: ["max"] });
    const onChange = render(gatedRow, "xhigh");
    act(() => required(".effort-track-apex-toggle").click());
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("max");

    render(gatedRow, "max", onChange);
    expect(track().dataset.apex).toBe("true");
    expect(track().dataset.atMax).toBe("true");
  });

  it("collapses 600ms after selecting an ordinary rung while open", () => {
    vi.useFakeTimers();
    const gatedRow = row({ gatedEfforts: ["max"] });
    const onChange = render(gatedRow, "max");
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("high");
    expect(track().dataset.apexOpen).toBe("true");

    render(gatedRow, "high", onChange);
    act(() => vi.advanceTimersByTime(599));
    expect(track().dataset.apexOpen).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(track().dataset.apexOpen).toBeUndefined();
    expect(document.querySelector("[data-apex-rung=true]")).toBeNull();
  });

  it("mounts open when the controlled value is gated", () => {
    render(row({ gatedEfforts: ["max"] }), "max");

    expect(track().dataset.apexOpen).toBe("true");
    expect(required(".effort-track-apex-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-apex-rung=true]")).toHaveLength(1);
  });

  it("preserves the gate-free rendering contract", () => {
    render(row(), "high");

    expect(document.querySelector(".effort-track-apex-toggle")).toBeNull();
    expect(document.querySelector(".effort-track-apex-seam")).toBeNull();
    expect(track().dataset.apexOpen).toBeUndefined();
    expect(track().dataset.apex).toBeUndefined();
    expect(stops()).toHaveLength(6);
  });
});

describe("effortLadderPosition", () => {
  it("counts the rung on the canonical axis, not on the rungs this model happens to offer", () => {
    // high는 이 모델이 내놓는 세 단 중 둘째지만, 축 위에서는 다섯 중 셋째다.
    expect(effortLadderPosition(row(), "high")).toEqual({ rung: 3, total: 5 });
    expect(effortLadderPosition(row(), "max")).toEqual({ rung: 5, total: 5 });
    // 자동은 0단이다 — 사다리를 쓰지 않는 상태이지 최소 단이 아니다.
    expect(effortLadderPosition(row(), null)).toEqual({ rung: 0, total: 5 });
  });

  it("falls back to the offered rungs when the row carries no axis", () => {
    expect(effortLadderPosition(row({ effortAxis: undefined }), "high")).toEqual({ rung: 2, total: 3 });
  });
});

describe("resolveRowEffort", () => {
  it("drops an effort the newly chosen model does not offer", () => {
    expect(resolveRowEffort(row(), "high")).toBe("high");
    // K3-1M has no medium rung — carrying it over would launch with a rung the model rejects.
    expect(resolveRowEffort(row(), "medium")).toBeNull();
    expect(resolveRowEffort(row({ chips: [] }), "high")).toBeNull();
    expect(resolveRowEffort(null, "high")).toBeNull();
  });
});
