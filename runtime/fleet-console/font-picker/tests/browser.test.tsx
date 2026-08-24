import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FontPicker } from "../browser.js";

const BUILT_INS = [
  { id: "manrope", label: "Manrope", family: "Manrope", aliases: ["UI Sans"] },
  { id: "duplicate", label: "UI Sans", family: "Another Sans" },
];
const INSTALLED = [{ family: "Saved Font", monospace: false }];
const SIZE_RANGE = { min: 10, max: 22, step: 1, defaultValue: 14 };
const containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

describe("FontPicker", () => {
  it("groups built-in and installed fonts and de-duplicates built-in aliases", () => {
    const container = renderPicker();
    expect(container.textContent).toContain("Built-in");
    expect(container.textContent).toContain("Installed on this machine");
    // BUILT_INS collide on the "UI Sans" alias, so only one built-in row survives (plus one installed row).
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect([...container.querySelectorAll<HTMLElement>('[role="option"]')].every((option) => option.tabIndex === -1)).toBe(true);
  });

  it("selects an available row via listbox keyboard navigation", async () => {
    const onSelectionChange = vi.fn();
    const container = renderPicker({
      builtIns: [
        { id: "manrope", label: "Manrope", family: "Manrope" },
        { id: "jetbrains", label: "JetBrains Mono", family: "JetBrains Mono" },
      ],
      installedFonts: [],
      onSelectionChange,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLDivElement;
    await act(async () => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSelectionChange).toHaveBeenCalledWith({ source: "builtin", id: "jetbrains" });
  });

  it("highlights a clicked row immediately by moving virtual focus to it", async () => {
    const onSelectionChange = vi.fn();
    const container = renderPicker({
      builtIns: [
        { id: "a", label: "Alpha", family: "'A', sans-serif" },
        { id: "b", label: "Beta", family: "'B', sans-serif" },
      ],
      installedFonts: [],
      selected: { source: "builtin", id: "a" },
      onSelectionChange,
    });
    const beta = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes("Beta"));
    if (!beta) throw new Error("Beta row must render.");
    await act(async () => beta.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelectionChange).toHaveBeenCalledWith({ source: "builtin", id: "b" });
    expect(beta.classList.contains("is-active")).toBe(true);
  });

  it("uses a selected option as virtual focus with safe, instance-local ids", () => {
    const container = renderPicker({ selected: { source: "system", familyName: "Saved Font" } });
    const listbox = container.querySelector('[role="listbox"]') as HTMLDivElement;
    const activeId = listbox.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const activeOption = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.id === activeId);
    expect(activeOption).toBeTruthy();
    if (!activeOption) throw new Error("The active descendant must reference an option.");
    expect(activeOption.textContent).toContain("Saved Font");
    expect(activeId).not.toContain(" ");
    expect([...container.querySelectorAll<HTMLElement>('[role="group"]')].map((group) => group.getAttribute("aria-labelledby"))).toEqual(expect.arrayContaining([
      expect.stringContaining("built-ins"),
      expect.stringContaining("installed"),
    ]));
  });

  it("does not duplicate group label ids when mounted twice", () => {
    const first = renderPicker();
    const second = renderPicker();
    const ids = [...first.querySelectorAll<HTMLElement>("h3[id]"), ...second.querySelectorAll<HTMLElement>("h3[id]")].map((heading) => heading.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders each row name in its own typeface", () => {
    const container = renderPicker({
      builtIns: [{ id: "manrope", label: "Manrope", family: "'Manrope Variable', sans-serif" }],
      installedFonts: [{ family: "Comic Sans MS", monospace: false }],
      fallbackStack: "sans-serif",
    });
    const names = [...container.querySelectorAll<HTMLElement>(".fc-font-browser__row-name")];
    const builtIn = names.find((name) => name.textContent === "Manrope");
    const system = names.find((name) => name.textContent === "Comic Sans MS");
    expect(builtIn?.style.fontFamily).toContain("Manrope Variable");
    expect(system?.style.fontFamily).toContain("Comic Sans MS");
    expect(system?.style.fontFamily).toContain("sans-serif");
  });

  it("previews a selected built-in in its own stack rather than the fallback", () => {
    const container = renderPicker({
      builtIns: [{ id: "jb", label: "JetBrains", family: "'JetBrains Mono Variable', monospace" }],
      installedFonts: [],
      selected: { source: "builtin", id: "jb" },
      fallbackStack: "sans-serif",
    });
    const preview = container.querySelector<HTMLElement>(".fc-font-browser__preview-copy");
    // A full built-in stack must be applied directly; quoting it via the fallback helper
    // would collapse it to one literal family and fall through to fallbackStack.
    expect(preview?.style.fontFamily).toContain("JetBrains Mono Variable");
    expect(preview?.style.fontFamily).not.toContain("sans-serif");
  });

  it("shows unavailable persisted rows plus loading and error states", () => {
    const container = renderPicker({ selected: { source: "system", familyName: "Missing Font" }, selectedSystemFont: "Missing Font", loading: true, error: "Catalog unavailable" });
    expect(container.textContent).toContain("Loading installed fonts");
    expect(container.textContent).toContain("Catalog unavailable");
    expect(container.textContent).toContain("Unavailable");
  });

  it("keeps search, listbox, disabled, and size controls explicitly labeled", () => {
    const container = renderPicker({ disabled: true, loading: true });
    const root = container.querySelector<HTMLElement>(".fc-font-browser");
    const search = container.querySelector<HTMLInputElement>(".fc-font-browser__search");
    const searchLabel = container.querySelector<HTMLLabelElement>(".fc-font-browser__search-label");
    const listbox = container.querySelector<HTMLElement>(".fc-font-browser__listbox");
    const sizeControl = container.querySelector<HTMLElement>(".fc-font-browser__size-control");

    expect(root?.dataset.disabled).toBe("true");
    expect(search?.disabled).toBe(true);
    expect(searchLabel?.htmlFor).toBe(search?.id);
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(listbox?.getAttribute("aria-label")).toBeTruthy();
    expect(listbox?.getAttribute("aria-busy")).toBe("true");
    expect(sizeControl?.getAttribute("role")).toBe("group");
    expect(sizeControl?.getAttribute("aria-label")).toBeTruthy();
    expect([...container.querySelectorAll<HTMLButtonElement>(".fc-font-browser__stepper")].every((button) => button.disabled && Boolean(button.getAttribute("aria-label")))).toBe(true);
    expect(container.querySelector(".fc-font-browser__range")?.getAttribute("aria-label")).toBeTruthy();
  });

  it("keeps slider draft local and commits once when its interaction ends", async () => {
    const onSizeCommit = vi.fn();
    const container = renderPicker({ onSizeCommit });
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    slider.value = "18";
    await act(async () => slider.dispatchEvent(new Event("input", { bubbles: true })));
    expect(onSizeCommit).not.toHaveBeenCalled();
    await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(onSizeCommit).toHaveBeenCalledTimes(1);
    expect(onSizeCommit).toHaveBeenCalledWith(18);
  });

  it("commits the live DOM slider value on release without relying on a flushed draft", async () => {
    const onSizeCommit = vi.fn();
    const container = renderPicker({ onSizeCommit });
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    // Simulate the real-browser race: the DOM value advances but the draft state has not flushed.
    slider.value = "20";
    await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(onSizeCommit).toHaveBeenCalledWith(20);
  });
});

function renderPicker(overrides: Partial<React.ComponentProps<typeof FontPicker>> = {}): HTMLDivElement {
  const container = document.createElement("div");
  containers.push(container);
  const root = createRoot(container);
  act(() => {
    root.render(<FontPicker builtIns={BUILT_INS} installedFonts={INSTALLED} selected={{ source: "builtin", id: "manrope" }} fallbackStack="sans-serif" previewText="Preview text" size={14} sizeRange={SIZE_RANGE} onSelectionChange={() => undefined} onSizeCommit={() => undefined} {...overrides} />);
  });
  return container;
}
