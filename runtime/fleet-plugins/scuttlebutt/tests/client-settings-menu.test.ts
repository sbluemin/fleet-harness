import { describe, expect, it, vi } from "vitest";

import {
  calculateSettingsMenuPlacement,
  CLOSED_SETTINGS_MENU,
  getSettingsRows,
  selectSettingsOption,
  transitionSettingsMenu,
  type SettingsMenuState,
} from "../client/settings-menu.js";

const rows = getSettingsRows({
  cliLabel: "Codex",
  cliValue: "codex",
  cliOptions: [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }],
  modelLabel: "GPT-5",
  modelValue: "gpt-5",
  modelOptions: [{ value: "gpt-5", label: "GPT-5" }, { value: "gpt-4", label: "GPT-4" }],
  effort: "high",
  effortOptions: [{ value: "medium", label: "medium" }, { value: "high", label: "high" }],
});

describe("Scuttlebutt settings menu state", () => {
  it("moves rows, opens an option list, and returns with Left", () => {
    let state = transitionSettingsMenu(CLOSED_SETTINGS_MENU, { type: "open" }, rows).state;
    state = transitionSettingsMenu(state, { type: "move-row", delta: 1 }, rows).state;
    expect(state.activeRow).toBe(1);
    state = transitionSettingsMenu(state, { type: "open-row", selectedIndex: 1 }, rows).state;
    expect(state).toMatchObject({ openRow: "model", activeOption: 1 });
    state = transitionSettingsMenu(state, { type: "move-option", delta: -1 }, rows).state;
    expect(state.activeOption).toBe(0);
    const back = transitionSettingsMenu(state, { type: "back" }, rows);
    expect(back).toMatchObject({ consumed: true, state: { open: true, openRow: null, activeRow: 1 } });
  });

  it("consumes Escape for submenu, then menu, then leaves it for the card", () => {
    const submenu: SettingsMenuState = {
      open: true,
      activeRow: 0,
      openRow: "cli",
      activeOption: 0,
    };
    const first = transitionSettingsMenu(submenu, { type: "escape" }, rows);
    expect(first).toMatchObject({ consumed: true, state: { open: true, openRow: null } });
    const second = transitionSettingsMenu(first.state, { type: "escape" }, rows);
    expect(second).toMatchObject({ consumed: true, state: { open: false } });
    expect(transitionSettingsMenu(second.state, { type: "escape" }, rows)).toMatchObject({
      consumed: false,
      state: { open: false },
    });
  });

  it("commits an option through the selection callback and closes", () => {
    const onSelect = vi.fn();
    const state = selectSettingsOption(
      { open: true, activeRow: 2, openRow: "reasoning", activeOption: 1 },
      "reasoning",
      "high",
      onSelect,
    );
    expect(onSelect).toHaveBeenCalledWith("reasoning", "high");
    expect(state).toEqual({ ...CLOSED_SETTINGS_MENU, activeRow: 2 });
  });

  it("omits the Reasoning row when the model exposes no effort levels", () => {
    const withoutReasoning = getSettingsRows({
      cliLabel: "Claude",
      cliValue: "claude",
      cliOptions: [],
      modelLabel: "Sonnet",
      modelValue: "sonnet",
      modelOptions: [],
      effort: "",
      effortOptions: [],
    });
    expect(withoutReasoning.map((row) => row.label)).toEqual(["Agent CLI", "Model"]);
    expect(rows.map((row) => row.label)).toEqual(["Agent CLI", "Model", "Reasoning"]);
  });
});

describe("Scuttlebutt settings menu placement", () => {
  it("opens upward and flips the submenu left when right-side space is short", () => {
    expect(calculateSettingsMenuPlacement({
      trigger: { left: 300, top: 500, width: 100, height: 34 },
      card: { left: 100, top: 100, width: 380, height: 440 },
      viewport: { left: 0, top: 0, width: 800, height: 600 },
      menu: { left: 300, top: 386, width: 176, height: 110 },
      row: { left: 300, top: 424, width: 176, height: 32 },
      submenu: { left: 0, top: 0, width: 148, height: 100 },
    })).toEqual({
      menu: { left: 0, top: -114 },
      submenu: { left: -152, top: -76, side: "left" },
    });
  });

  it("clamps both panels to the card and viewport intersection", () => {
    const placement = calculateSettingsMenuPlacement({
      trigger: { left: 110, top: 130, width: 100, height: 34 },
      card: { left: 100, top: 100, width: 250, height: 200 },
      viewport: { left: 0, top: 0, width: 320, height: 240 },
      menu: { left: 110, top: 104, width: 176, height: 160 },
      row: { left: 110, top: 130, width: 176, height: 32 },
      submenu: { left: 0, top: 0, width: 148, height: 150 },
    });
    expect(placement.menu).toEqual({ left: 0, top: -26 });
    expect(placement.submenu).toEqual({ left: 58, top: -26, side: "right" });
  });
});
