// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { EffortTrack, resolveRowEffort } from "../core/client/src/components/effort-track.js";

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

function render(node: OperationLaunchVariantRow, value: string | null, onChange = vi.fn()) {
  act(() => root.render(
    <EffortTrack
      row={node}
      value={value}
      onChange={onChange}
      autoLabel="AUTO"
      ariaLabel="Reasoning effort"
      autoValueText="Automatic"
    />,
  ));
  return onChange;
}

function stops(): readonly HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".effort-track-stop"));
}

function track(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".effort-track");
  if (!element) throw new Error("Expected the track");
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

  it("marks only the top rung as the one at maximum", () => {
    render(row(), "max");
    expect(track().dataset.atMax).toBe("true");

    render(row(), "high");
    expect(track().dataset.atMax).toBeUndefined();

    // 비운 상태는 축의 맨 앞이지 최대가 아니다.
    render(row({ chips: [] }), null);
    expect(track().dataset.atMax).toBeUndefined();
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
