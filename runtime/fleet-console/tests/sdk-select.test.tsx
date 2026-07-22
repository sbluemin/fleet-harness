// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Select, type SelectOption } from "@fleet-console/sdk/react/browser";
import { SettingsSelect } from "@fleet-console/sdk/settings/browser";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_OPTIONS: readonly SelectOption[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma", disabled: true },
  { value: "delta", label: "Delta" },
];

function renderSelect(
  props: Partial<{
    value: string;
    options: readonly SelectOption[];
    onChange: (next: string) => void;
    disabled: boolean;
    compact: boolean;
  }> = {},
): { onChange: ReturnType<typeof vi.fn<(next: string) => void>> } {
  const onChange = vi.fn<(next: string) => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(Select, {
        value: props.value ?? "alpha",
        options: props.options ?? BASE_OPTIONS,
        onChange: props.onChange ?? onChange,
        disabled: props.disabled,
        compact: props.compact,
        label: "Test select",
      }),
    );
  });
  return { onChange: props.onChange ? (props.onChange as ReturnType<typeof vi.fn>) : onChange };
}

function trigger(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".fc-select__trigger");
  if (!button) throw new Error("missing trigger");
  return button;
}

function popup(): HTMLUListElement {
  const list = document.querySelector<HTMLUListElement>(".fc-select__popup");
  if (!list) throw new Error("missing popup");
  return list;
}

function options(): HTMLLIElement[] {
  return Array.from(document.querySelectorAll<HTMLLIElement>(".fc-select__option"));
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("Select behavior", () => {
  it("commits a controlled value on option click", () => {
    const { onChange } = renderSelect();
    act(() => trigger().click());
    act(() => options()[1]?.click());
    expect(onChange).toHaveBeenCalledWith("beta");
    expect(trigger().textContent).toContain("Alpha");
  });

  it("wraps arrow navigation while skipping disabled options", () => {
    renderSelect({ value: "delta" });
    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    const active = options().find((option) => option.dataset.active === "true");
    expect(active?.textContent).toBe("Beta");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Alpha");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Delta");
  });

  it("jumps to first and last enabled options with Home and End", () => {
    renderSelect({ value: "beta" });
    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Delta");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Alpha");
  });

  it("matches case-insensitive typeahead within 500 ms", () => {
    renderSelect({ value: "alpha" });
    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Delta");
    act(() => {
      vi.advanceTimersByTime(500);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    });
    expect(options().find((option) => option.dataset.active === "true")?.textContent).toBe("Beta");
  });

  it("portals the popup to document.body and removes it on close", () => {
    renderSelect();
    act(() => trigger().click());
    const list = popup();
    expect(list.parentElement).toBe(document.body);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".fc-select__popup")).toBeNull();
  });

  it("flips upward when lower viewport space is insufficient", () => {
    renderSelect();
    const button = trigger();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 12,
      y: window.innerHeight - 20,
      width: 180,
      height: 42,
      top: window.innerHeight - 20,
      right: 192,
      bottom: window.innerHeight + 22,
      left: 12,
      toJSON: () => ({}),
    });
    act(() => button.click());
    expect(popup().dataset.placement).toBe("up");
  });

  it("closes on Escape, Tab, and outside pointerdown while returning focus", () => {
    renderSelect();
    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".fc-select__popup")).toBeNull();
    expect(document.activeElement).toBe(trigger());

    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.querySelector(".fc-select__popup")).toBeNull();

    act(() => trigger().click());
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector(".fc-select__popup")).toBeNull();
  });

  it("updates options dynamically and keeps complete ARIA state", () => {
    const { onChange } = renderSelect();
    act(() => trigger().click());
    const list = popup();
    expect(trigger().getAttribute("role")).toBe("combobox");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(list.id);
    expect(trigger().getAttribute("aria-activedescendant")).toBeTruthy();
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    expect(list.getAttribute("tabindex")).toBeNull();
    for (const option of options()) {
      expect(option.getAttribute("role")).toBe("option");
      expect(option.hasAttribute("aria-selected")).toBe(true);
    }
    expect(options()[2]?.getAttribute("aria-disabled")).toBe("true");

    const nextOptions: readonly SelectOption[] = [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ];
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    act(() => {
      root?.render(
        createElement(Select, {
          value: "two",
          options: nextOptions,
          onChange,
          label: "Test select",
        }),
      );
    });
    act(() => trigger().click());
    expect(options()).toHaveLength(2);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("reflects external aria-labelledby on the trigger and listbox", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement("div", null, [
          createElement("span", { id: "field-label", key: "label" }, "Default model"),
          createElement(Select, {
            key: "select",
            value: "alpha",
            options: BASE_OPTIONS,
            onChange: vi.fn(),
            "aria-labelledby": "field-label",
          }),
        ]),
      );
    });
    act(() => trigger().click());
    expect(trigger().getAttribute("aria-labelledby")).toBe("field-label");
    expect(popup().getAttribute("aria-labelledby")).toBe("field-label");
    expect(trigger().getAttribute("aria-label")).toBeNull();
  });

  it("scrolls the active option into view when navigation changes", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderSelect({ value: "alpha" });
    act(() => trigger().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("applies compact popup modifier and right-aligns the portaled surface", () => {
    renderSelect({ compact: true });
    const button = trigger();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 40,
      width: 80,
      height: 24,
      top: 40,
      right: 180,
      bottom: 64,
      left: 100,
      toJSON: () => ({}),
    });
    act(() => button.click());
    const list = popup();
    expect(list.classList.contains("fc-select__popup--compact")).toBe(true);
    expect(list.style.left).toBe(`${180 - 160}px`);
    expect(list.style.width).toBe("160px");
  });

  it("clamps compact popup left edge to the viewport margin", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    renderSelect({ compact: true });
    const button = trigger();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 40,
      width: 80,
      height: 24,
      top: 40,
      right: 80,
      bottom: 64,
      left: 0,
      toJSON: () => ({}),
    });
    act(() => button.click());
    expect(Number.parseFloat(popup().style.left)).toBeGreaterThanOrEqual(8);
    expect(popup().style.width).toBe("160px");
  });

  it("clamps compact popup right edge inside the viewport margin", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    renderSelect({ compact: true });
    const button = trigger();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 710,
      y: 40,
      width: 80,
      height: 24,
      top: 40,
      right: 790,
      bottom: 64,
      left: 710,
      toJSON: () => ({}),
    });
    act(() => button.click());
    expect(Number.parseFloat(popup().style.left)).toBeLessThanOrEqual(800 - 160 - 8);
    expect(popup().style.width).toBe("160px");
  });

  it("caps default popup width to the viewport margin box", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    renderSelect({ compact: false });
    const button = trigger();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 8,
      y: 40,
      width: 500,
      height: 42,
      top: 40,
      right: 508,
      bottom: 82,
      left: 8,
      toJSON: () => ({}),
    });
    act(() => button.click());
    expect(popup().style.width).toBe("384px");
    expect(Number.parseFloat(popup().style.left)).toBe(8);
  });
});

describe("SettingsSelect public contract", () => {
  it("keeps label association, disabled state, and onChange(next: string)", () => {
    const onChange = vi.fn<(next: string) => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(SettingsSelect, {
          label: "Theme",
          value: "carbon",
          disabled: false,
          options: [
            { value: "instrument", label: "Instrument" },
            { value: "carbon", label: "Carbon" },
          ],
          onChange,
        }),
      );
    });

    const label = container.querySelector<HTMLSpanElement>(".fc-settings-select__label");
    const trigger = container.querySelector<HTMLButtonElement>(".fc-select__trigger");
    expect(label?.textContent).toBe("Theme");
    expect(trigger?.getAttribute("aria-labelledby")).toBe(label?.id);
    expect(trigger?.textContent).toContain("Carbon");

    act(() => trigger?.click());
    act(() => {
      [...document.querySelectorAll<HTMLLIElement>(".fc-select__option")]
        .find((option) => option.textContent === "Instrument")
        ?.click();
    });
    expect(onChange).toHaveBeenCalledWith("instrument");
  });

  it("uses the unlabeled fallback aria label", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(SettingsSelect, {
          value: "one",
          options: [{ value: "one", label: "One" }],
          onChange: vi.fn(),
          disabled: true,
        }),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(".fc-select__trigger");
    expect(trigger?.getAttribute("aria-label")).toBe("Select setting");
    expect(trigger?.disabled).toBe(true);
  });
});
