// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../core/client/src/focus-guards.js";

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

function createPanelWithCommandBandToggle(panelClass: string, toggleClass: string) {
  const toggle = document.createElement("button");
  toggle.className = toggleClass;
  const panel = document.createElement("section");
  panel.className = panelClass;
  const panelControl = document.createElement("button");
  panel.append(panelControl);
  document.body.append(toggle, panel);
  return { panel, panelControl, toggle };
}

describe("Command Band focus handoff", () => {
  it.each([
    ["operations-side-bar", "command-band-sidebar-toggle"],
    ["right-rail", "command-band-rail-toggle"],
  ])("moves %s internal focus to its Command Band toggle when collapsed", (panelClass, toggleClass) => {
    const { panel, panelControl, toggle } = createPanelWithCommandBandToggle(panelClass, toggleClass);

    panelControl.focus();
    focusCommandBandToggleWhenPanelContainsActiveElement(panel, `.${toggleClass}`);

    expect(document.activeElement).toBe(toggle);
  });

  it("keeps Command Band focus during repeated toggle clicks", () => {
    const { panel, toggle } = createPanelWithCommandBandToggle("operations-side-bar", "command-band-sidebar-toggle");

    toggle.focus();
    focusCommandBandToggleWhenPanelContainsActiveElement(panel, ".command-band-sidebar-toggle");
    focusCommandBandToggleWhenPanelContainsActiveElement(panel, ".command-band-sidebar-toggle");

    expect(document.activeElement).toBe(toggle);
  });
});
