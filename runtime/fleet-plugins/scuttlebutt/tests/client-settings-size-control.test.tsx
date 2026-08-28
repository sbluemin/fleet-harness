// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scuttlebuttSettingsSection } from "../client/settings-section.js";
import {
  connectScuttlebuttSettings,
  getScuttlebuttSettings,
} from "../client/settings-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let disconnect: () => void;

function capability(stored: Record<string, unknown> | null): ClientSettingsCapability {
  return {
    read: vi.fn().mockResolvedValue(stored),
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClientSettingsCapability;
}

const settle = () => act(async () => { await Promise.resolve(); });

function ranges(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>(".fc-settings-slider input[type=range]")];
}

/** React 는 자체 value tracker 로 중복 입력을 걸러 내므로 네이티브 setter 로 값을 넣어야 한다. */
function drag(range: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(range, String(value));
  range.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  disconnect?.();
});

describe("Scuttlebutt size control", () => {
  async function mount(stored: Record<string, unknown> | null): Promise<ClientSettingsCapability> {
    const settings = capability(stored);
    disconnect = connectScuttlebuttSettings(settings);
    await settle();
    await act(async () => {
      root.render(scuttlebuttSettingsSection.render?.());
    });
    return settings;
  }

  it("shows a size row only for aides that are on duty", async () => {
    await mount({ tori: true, bori: true });
    expect(ranges()).toHaveLength(2);
    expect(ranges().map((r) => [r.min, r.max, r.step])).toEqual([
      ["48", "112", "4"],
      ["48", "112", "4"],
    ]);
  });

  it("previews while dragging and saves once when the gesture ends", async () => {
    const settings = await mount({ tori: true });
    const range = ranges()[0]!;

    await act(async () => { drag(range, 64); drag(range, 56); });
    // 끄는 동안 화면은 따라오지만 저장은 아직 나가지 않는다.
    expect(getScuttlebuttSettings().sizes.tori).toBe(56);
    expect(settings.write).not.toHaveBeenCalled();

    await act(async () => {
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      range.dispatchEvent(new FocusEvent("blur"));
    });
    await settle();

    // pointerup 과 blur 가 잇달아 와도 저장은 한 번뿐이다.
    expect(settings.write).toHaveBeenCalledTimes(1);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", expect.objectContaining({
      sizes: { tori: 56, bori: 84, dori: 84 },
    }));
  });

  it("does not let a failed save undo a newer adjustment of the same aide", async () => {
    const settings = await mount({ tori: true });
    const range = ranges()[0]!;

    let failFirst!: (reason: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => { failFirst = reject; });
    settings.write = vi.fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined);

    // 첫 조작을 저장으로 넘긴다 — 아직 끝나지 않는다.
    await act(async () => {
      drag(range, 48);
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    // 저장이 매달린 사이 같은 부관을 다시 조절한다. 크기 컨트롤은 저장 중에도 잠기지 않는다.
    await act(async () => {
      drag(range, 96);
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    await act(async () => {
      failFirst(new Error("first save failed"));
      await Promise.resolve();
    });
    await settle();

    // 실패한 옛 저장이 새 값을 되돌리면 화면과 저장이 갈린 채로 남는다.
    expect(getScuttlebuttSettings().sizes.tori).toBe(96);
  });

  it("returns a single aide to the standard size without touching the others", async () => {
    const settings = await mount({ tori: true, bori: true, sizes: { tori: 48, bori: 112 } });
    const reset = container.querySelectorAll<HTMLButtonElement>(".scuttlebutt-settings-size-reset");

    await act(async () => { reset[0]!.click(); });
    await settle();

    expect(getScuttlebuttSettings().sizes).toEqual({ tori: 84, bori: 112, dori: 84 });
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", expect.objectContaining({
      sizes: { tori: 84, bori: 112, dori: 84 },
    }));
  });

  it("falls back to the last confirmed size when consecutive saves both fail", async () => {
    const settings = await mount({ tori: true });
    const range = ranges()[0]!;
    expect(getScuttlebuttSettings().sizes.tori).toBe(84);

    let failFirst!: (reason: Error) => void;
    let failSecond!: (reason: Error) => void;
    const first = new Promise<void>((_r, reject) => { failFirst = reject; });
    const second = new Promise<void>((_r, reject) => { failSecond = reject; });
    settings.write = vi.fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockResolvedValue(undefined);

    await act(async () => {
      drag(range, 48);
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    // 두 번째 조작은 첫 번째의 아직 저장되지 않은 값(48)이 보이는 상태에서 시작한다.
    await act(async () => {
      drag(range, 96);
      range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    await act(async () => {
      failFirst(new Error("first save failed"));
      failSecond(new Error("second save failed"));
      await Promise.resolve();
    });
    await settle();

    // 둘 다 실패했으면 화면은 서버가 마지막으로 받아들인 84로 돌아가야 한다. 48은 한 번도
    // 저장된 적 없는 값이므로 그 자리에 남으면 화면과 저장이 갈린다.
    expect(getScuttlebuttSettings().sizes.tori).toBe(84);
  });

  it("keeps another aide's in-progress drag when a save fails", async () => {
    const settings = await mount({ tori: true, bori: true });
    const [toriRange, boriRange] = ranges() as [HTMLInputElement, HTMLInputElement];

    let failTori!: (reason: Error) => void;
    const gate = new Promise<void>((_r, reject) => { failTori = reject; });
    settings.write = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);

    await act(async () => {
      drag(toriRange, 48);
      toriRange.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    // 토리의 저장이 떠 있는 동안 보리를 끌기 시작한다.
    await act(async () => { drag(boriRange, 112); });
    expect(getScuttlebuttSettings().sizes.bori).toBe(112);

    await act(async () => {
      failTori(new Error("tori save failed"));
      await Promise.resolve();
    });
    await settle();

    // 토리는 확인된 값으로 돌아가되, 보리가 손에 쥐고 있던 조작은 살아 있어야 한다.
    expect(getScuttlebuttSettings().sizes.tori).toBe(84);
    expect(getScuttlebuttSettings().sizes.bori).toBe(112);
    expect(ranges()[1]!.value).toBe("112");
  });

  it("does not persist another aide's uncommitted preview", async () => {
    const settings = await mount({ tori: true, bori: true });
    const [toriRange, boriRange] = ranges() as [HTMLInputElement, HTMLInputElement];

    // 보리는 아직 끌고 있는 중 — 확정되지 않았다.
    await act(async () => { drag(boriRange, 112); });
    // 그 사이 토리를 확정한다.
    await act(async () => {
      drag(toriRange, 48);
      toriRange.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await settle();

    // 저장된 문서에는 토리의 확정값만 들어가고 보리는 확정값 그대로여야 한다.
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", expect.objectContaining({
      sizes: { tori: 48, bori: 84, dori: 84 },
    }));
    // 화면에서는 보리의 진행 중인 조작이 그대로 보인다.
    expect(getScuttlebuttSettings().sizes.bori).toBe(112);
  });
});
