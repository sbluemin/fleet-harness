import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FONTS } from "../features/settings/shared/fonts.js";
import { DEFAULT_EXPERIMENT_SETTINGS } from "../features/settings/shared/experiments.js";
import type { GlobalSettingsState } from "../core/client/src/integration/types.js";

vi.mock("../features/settings/client/global-settings-api.js", () => ({
  fetchGlobalSettingsState: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const BASE: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  seenFeatureTours: [],
  theme: "dark",
  sideBarDoubleClickOpen: false,
  reduceMotion: false,
  calmAvatars: false,
  avatarFuzz: 1.05,
  commodoreComposerChipsExpanded: false,
  commanderSort: null,
  commanderFolds: null,
  commanderKeepExpanded: null,
  commanderShowSettled: null,
  conversationView: null,
  lowerUnfocusedFrameRate: true,
  taskforceBubbleColor: false,
  shortcuts: {},
  fonts: DEFAULT_FONTS,
  uiFont: { source: "builtin", id: "manrope", size: 14 },
  language: "auto",
  experiments: DEFAULT_EXPERIMENT_SETTINGS,
  archiveRetentionDays: null,
};

/** 목표 보드는 옵트인 실험 — 꺼져 있으면 어떤 길로도 열리지 않고, 끄는 순간 열려 있던 보드도 닫힌다. */
describe("command board experiment gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("stays closed before settings load and while the experiment is off", async () => {
    const board = await import("../features/workspace/client/command-board/command-board-store.js");
    const settings = await import("../features/settings/client/global-settings-store.js");
    expect(board.openCommandBoard()).toBe(false);
    settings.hydrateGlobalSettings(BASE);
    expect(board.openCommandBoard()).toBe(false);
    expect(board.toggleCommandBoard()).toBe(false);
    expect(board.isCommandBoardOpen()).toBe(false);
  });

  it("opens when on and closes an open board as soon as the experiment turns off", async () => {
    const board = await import("../features/workspace/client/command-board/command-board-store.js");
    const settings = await import("../features/settings/client/global-settings-store.js");
    settings.hydrateGlobalSettings({ ...BASE, experiments: { ...DEFAULT_EXPERIMENT_SETTINGS, commandBoard: true } });
    expect(board.openCommandBoard()).toBe(true);
    expect(board.isCommandBoardOpen()).toBe(true);
    settings.hydrateGlobalSettings(BASE);
    expect(board.isCommandBoardOpen()).toBe(false);
    expect(board.toggleCommandBoard()).toBe(false);
  });
});
