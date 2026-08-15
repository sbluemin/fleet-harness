// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isMapActivationSurface, shouldReleaseActiveOperation } from "../core/client/src/active-operation-surface.js";

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  const child = host.firstElementChild;
  if (!(child instanceof HTMLElement)) throw new Error("expected an element");
  return child;
}

describe("shouldReleaseActiveOperation", () => {
  it("releases when the click is on the left sidebar chrome", () => {
    const sidebar = el(`<aside class="operations-side-bar"><div class="side-bar-theater-name">Harbor</div></aside>`);
    document.body.append(sidebar);
    expect(shouldReleaseActiveOperation(sidebar.querySelector(".side-bar-theater-name"))).toBe(true);
    sidebar.remove();
  });

  it("releases when the click is on the right rail chrome", () => {
    const rail = el(`<div class="right-rail"><button type="button">Alerts</button></div>`);
    document.body.append(rail);
    expect(shouldReleaseActiveOperation(rail.querySelector("button"))).toBe(true);
    rail.remove();
  });

  it("keeps activation on a sidebar chip that selects an Operation", () => {
    const chip = el(`<li data-side-bar-chip-id="op-1" class="side-bar-chip">Session</li>`);
    const sidebar = el(`<aside class="operations-side-bar"></aside>`);
    sidebar.append(chip);
    document.body.append(sidebar);
    expect(shouldReleaseActiveOperation(chip)).toBe(false);
    sidebar.remove();
  });

  it("keeps activation on the Map and on a panel frame", () => {
    const canvas = el(`<main class="operations-canvas"><article class="canvas-operation" data-canvas-operation><div class="canvas-operation-titlebar">Panel</div></article></main>`);
    document.body.append(canvas);
    expect(isMapActivationSurface(canvas)).toBe(true);
    expect(shouldReleaseActiveOperation(canvas.querySelector(".canvas-operation-titlebar"))).toBe(false);
    expect(shouldReleaseActiveOperation(canvas)).toBe(false);
    canvas.remove();
  });

  it("keeps activation on a Map-owned portal menu", () => {
    const menu = el(`<div class="accent-popover-overlay" data-keep-operation-active><button type="button">Accent</button></div>`);
    document.body.append(menu);
    expect(shouldReleaseActiveOperation(menu.querySelector("button"))).toBe(false);
    menu.remove();
  });

  it("does not release while a blocking dialog is open", () => {
    const dialog = el(`<div role="dialog" aria-modal="true">Confirm</div>`);
    const sidebar = el(`<aside class="operations-side-bar"><div class="side-bar-theater-name">Harbor</div></aside>`);
    document.body.append(dialog, sidebar);
    expect(shouldReleaseActiveOperation(sidebar.querySelector(".side-bar-theater-name"))).toBe(false);
    dialog.remove();
    sidebar.remove();
  });
});

describe("operations page wires Map-outside release", () => {
  const source = readFileSync(resolve(process.cwd(), "core/client/src/pages/operations.tsx"), "utf8");

  it("clears the active Operation from a capture pointerdown outside the Map", () => {
    expect(source).toContain("shouldReleaseActiveOperation(event.target)");
    expect(source).toContain("clearActiveOperation()");
    expect(source).toContain("document.addEventListener(\"pointerdown\", onPointerDown, true)");
  });
});
