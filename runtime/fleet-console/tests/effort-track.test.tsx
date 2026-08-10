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

const CHAMBER_AXIS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;

/** 평범한 레일이 xhigh에서 끊기고 max·ultracode가 챔버 뒤에 사는 행. */
function chamberRow(overrides: Partial<OperationLaunchVariantRow> = {}): OperationLaunchVariantRow {
  return {
    id: "claude--fable",
    label: "FABLE-1M",
    launch: { model: "fable[1m]" },
    effortAxis: [...CHAMBER_AXIS],
    effortExpansion: { after: "xhigh", rungs: ["max", "ultracode"] },
    chips: CHAMBER_AXIS.map((id) => ({
      id,
      label: id.toUpperCase(),
      launch: { model: "fable[1m]", effort: id },
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
      revealLabel="Reveal high-cost efforts"
      collapseLabel="Put the high-cost efforts away"
      specialWarning="High cost"
    />,
  ));
  return onChange;
}

function stubTrackPointer(width = 126) {
  const element = track();
  let captured: number | null = null;
  const rect = (box: number) => () => ({ left: 0, right: box, top: 0, bottom: 26, width: box, height: 26, x: 0, y: 0, toJSON: () => ({}) });
  // 좌표계는 프레임이 소유한다 — 접힌 레일은 축의 일부만 덮으므로 그 폭으로 자리를 잴 수 없다.
  const frame = document.querySelector<HTMLElement>(".effort-track-frame");
  if (frame) Object.defineProperty(frame, "getBoundingClientRect", { configurable: true, value: rect(width) });
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: rect(width),
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
    // 자리는 손잡이 여백을 뺀 폭 위에서 잰다 — 양 끝 스톱에서 손잡이가 트랙을 넘지 않아야 한다.
    expect(marks[3]!.style.left).toBe("calc(13px + 0.6 * (100% - 26px))");
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
    // 아직 잡은 포인터가 없으므로 hasPointerCapture는 false다 — 이동만으로는 값이 바뀌지 않는다.
    stubTrackPointer();

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
});

describe("effortLadderPosition", () => {
  it("counts the rung on the canonical axis, not on the rungs this model happens to offer", () => {
    // high는 이 모델이 내놓는 세 단 중 둘째지만, 축 위에서는 다섯 중 셋째다.
    expect(effortLadderPosition(row(), "high")).toEqual({ rung: 3, total: 5, special: null });
    expect(effortLadderPosition(row(), "max")).toEqual({ rung: 5, total: 5, special: null });
    // 자동은 0단이다 — 사다리를 쓰지 않는 상태이지 최소 단이 아니다.
    expect(effortLadderPosition(row(), null)).toEqual({ rung: 0, total: 5, special: null });
  });

  it("falls back to the offered rungs when the row carries no axis", () => {
    expect(effortLadderPosition(row({ effortAxis: undefined }), "high")).toEqual({ rung: 2, total: 3, special: null });
  });

  // 챔버 안의 단은 눈금 하나가 아니다. 막대를 더 얹으면 "칸이 많으니 더 깊다"를 그리는데,
  // ultracode는 xhigh 깊이에 오케스트레이션을 얹은 모드다.
  it("counts the gauge only up to the ordinary rail and reports the special mode apart from it", () => {
    expect(effortLadderPosition(chamberRow(), "xhigh")).toEqual({ rung: 4, total: 4, special: null });
    expect(effortLadderPosition(chamberRow(), "max")).toEqual({ rung: 4, total: 4, special: "max" });
    expect(effortLadderPosition(chamberRow(), "ultracode")).toEqual({ rung: 4, total: 4, special: "ultracode" });
  });
});

// 챔버는 값을 숨기는 장치가 아니라 스쳐서 닿지 않게 하는 장치다. 아래 성질들이 그 구분을 진다.
describe("EffortTrack high-cost chamber", () => {
  function gate(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".effort-track-gate");
  }

  it("caps the ordinary rail at the expansion boundary and reserves the rest for the gate", () => {
    render(chamberRow(), "high");

    // AUTO + low..xhigh만 선다. max·ultracode는 자리를 잡아 두고도 아직 눈에 없다.
    expect(stops()).toHaveLength(5);
    expect(track().getAttribute("aria-valuemax")).toBe("4");
    expect(gate()).not.toBeNull();
    expect(document.querySelector(".effort-track-chamber-note")).toBeNull();
  });

  it("cannot reach a chamber rung by dragging past the end of the collapsed rail", () => {
    const onChange = render(chamberRow(), "low");
    const element = stubTrackPointer();

    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 30, clientY: 13 }));
      // 트랙 끝을 지나 한참 밖까지 끌어도 평범한 천장에서 멈춘다.
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 400, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 400, clientY: 13 }));
    });

    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["xhigh"]);
  });

  it("opens the chamber only on the gate, and keeps the ordinary rungs on the same coordinates", () => {
    render(chamberRow(), "high");
    const highLeft = stops()[3]!.style.left;

    act(() => gate()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(stops()).toHaveLength(7);
    expect(track().getAttribute("aria-valuemax")).toBe("6");
    expect(gate()).toBeNull();
    // 펼쳐도 xhigh는 제자리다 — 축이 눈금을 다시 그리면 방금 고른 값이 옮겨 간 것처럼 읽힌다.
    expect(stops()[3]!.style.left).toBe(highLeft);
    // 비용은 챔버가 열려 있는 동안 계속 화면에 남고, 닫는 손잡이도 그 알림과 함께 흐름 밖에 뜬다.
    const note = document.querySelector(".effort-track-chamber-note");
    expect(note?.querySelector("[role='status']")?.textContent).toBe("High cost");
    expect(note?.querySelector(".effort-track-collapse")).not.toBeNull();
    // 게이트가 사라지므로 초점은 레일로 옮겨 간다 — body로 떨어지면 키보드 경로가 끊긴다.
    expect(document.activeElement).toBe(track());
  });

  it("lets the pointer reach a chamber rung once the chamber is open", () => {
    const onChange = render(chamberRow(), "high");
    act(() => gate()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const element = stubTrackPointer();

    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
    });

    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["ultracode"]);
  });

  it("arms a chamber rung without launching it, however the press arrives", () => {
    const onChange = vi.fn();
    const onConfirmCurrent = vi.fn();
    render(chamberRow(), "ultracode", onChange, onConfirmCurrent);
    const element = stubTrackPointer();

    // 이미 실린 단을 다시 눌러도 실행되지 않는다 — 평범한 단이라면 여기서 확정된다.
    act(() => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: 113, clientY: 13 }));
    });
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(onConfirmCurrent).not.toHaveBeenCalled();
  });

  it("still confirms an ordinary rung while the chamber is open", () => {
    const onConfirmCurrent = vi.fn();
    render(chamberRow(), "xhigh", vi.fn(), onConfirmCurrent);
    act(() => gate()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(onConfirmCurrent).toHaveBeenCalledTimes(1);
  });

  it("hands the arrow key at the ceiling to the gate instead of opening the chamber", () => {
    const onChange = render(chamberRow(), "xhigh");

    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));

    // 방향키가 비싼 모드를 여는 손잡이가 되면 그 문은 문이 아니다.
    expect(onChange).not.toHaveBeenCalled();
    expect(stops()).toHaveLength(5);
    expect(document.activeElement).toBe(gate());
  });

  it("never leaves a chamber rung armed behind a closed rail", () => {
    // 이미 특수 단이 실려 들어오면 챔버는 열린 채로 그려진다 — 접힌 레일이 비싼 모드를 숨기면
    // 아무도 고르지 않은 값으로 다음 실행이 나간다.
    const onChange = render(chamberRow(), "max");
    expect(stops()).toHaveLength(7);
    expect(gate()).toBeNull();
    expect(track().dataset.special).toBe("max");

    // 접는 것은 그 모드를 내려놓는 일이다. 값이 남은 채 사라질 수는 없다.
    act(() => track().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([null]);
  });

  it("keeps the top of the collapsed rail reading as the ceiling", () => {
    render(chamberRow(), "xhigh");
    expect(track().dataset.atMax).toBe("true");

    render(chamberRow(), "high");
    expect(track().dataset.atMax).toBeUndefined();
  });

  it("reads the chamber rung by what the mode is, not by its short label", () => {
    act(() => root.render(
      <EffortTrack
        row={chamberRow()}
        value="ultracode"
        onChange={vi.fn()}
        autoLabel="AUTO"
        ariaLabel="Reasoning effort"
        autoValueText="Automatic"
        specialDescriptions={{ ultracode: "XHIGH plus orchestration" }}
      />,
    ));

    expect(track().getAttribute("aria-valuetext")).toBe("XHIGH plus orchestration");
  });

  it("leaves rows without a chamber exactly as they were", () => {
    render(row(), "max");
    expect(gate()).toBeNull();
    expect(track().getAttribute("aria-valuemax")).toBe("5");
    expect(track().dataset.atMax).toBe("true");
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
