import type { Component, Focusable } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { FleetInfraServices, SectionDisplayConfig } from "@sbluemin/fleet-core";

import { getKeybindAPI } from "./keybinds.js";
import { getFleetRuntime } from "./fleet.js";

export interface FleetPushModeSettings {
  deliverAs?: "followUp" | "steer";
}

const SECTION_KEY = "fleet-push-mode";

const LABEL_WIDTH = 11;
const PANEL_COLOR = "\x1b[38;2;180;160;220m";
const ANSI_RESET = "\x1b[0m";

let activePopup: Promise<void> | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// SettingsOverlay
// ═══════════════════════════════════════════════════════════════════════════

class SettingsOverlay implements Component, Focusable {
  focused = false;

  private readonly theme: Theme;
  private readonly sections: SectionDisplayConfig[];
  private readonly done: () => void;

  constructor(
    theme: Theme,
    sections: SectionDisplayConfig[],
    done: () => void,
  ) {
    this.theme = theme;
    this.sections = sections;
    this.done = done;
  }

  handleInput(): void {
    this.done();
  }

  render(width: number): string[] {
    width = Math.max(30, width);

    const border = (s: string) => this.theme.fg("border", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const innerWidth = width - 4;
    const row = (content: string) => {
      const pad = Math.max(0, innerWidth - visibleWidth(content));
      return border("│ ") + content + " ".repeat(pad) + border(" │");
    };
    const emptyRow = () => row("");
    const settingRow = (label: string, value: string, color: string) => {
      const paddedLabel = " ".repeat(Math.max(0, LABEL_WIDTH - label.length)) + label;
      return row(`  ${dim(paddedLabel)}  ${this.theme.fg(color as ThemeColor, value)}`);
    };

    const title = " Settings ";
    const titleLen = title.length;
    const sideLen = Math.max(0, Math.floor((width - 2 - titleLen) / 2));
    const rightLen = Math.max(0, width - 2 - sideLen - titleLen);
    const topBorder = border("╭" + "─".repeat(sideLen) + title + "─".repeat(rightLen) + "╮");
    const lines: string[] = [];
    lines.push(topBorder);
    lines.push(emptyRow());

    for (const section of this.sections) {
      lines.push(row(`  ${PANEL_COLOR}◇${ANSI_RESET} ${PANEL_COLOR}${section.displayName}${ANSI_RESET}`));
      const fields = section.getDisplayFields();
      for (const field of fields) {
        lines.push(settingRow(field.label, field.value, field.color ?? "accent"));
      }
      lines.push(emptyRow());
    }

    if (this.sections.length === 0) {
      lines.push(row(dim("등록된 설정 섹션이 없습니다.")));
      lines.push(emptyRow());
    }

    lines.push(border("├" + "─".repeat(width - 2) + "┤"));
    lines.push(row(dim("Esc close")));
    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));

    return lines;
  }

  invalidate(): void {}

  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// 공개 API
// ═══════════════════════════════════════════════════════════════════════════

export function registerSettings(_ctx: ExtensionAPI): void {
  registerSettingsOverlayKeybind();
  registerPushModeSettingsSection();
}

export function loadSettings(): FleetPushModeSettings {
  try {
    return getInfraSettingsFacade().getSettingsService()?.load<FleetPushModeSettings>(SECTION_KEY) ?? {};
  } catch {
    return {};
  }
}

export function saveSettings(settings: FleetPushModeSettings): void {
  getInfraSettingsFacade().getSettingsService()?.save(SECTION_KEY, settings);
}

export function getDeliverAs(): "followUp" | "steer" {
  const deliverAs = loadSettings().deliverAs;
  return deliverAs === "steer" ? "steer" : "followUp";
}

export async function setDeliverAs(value: "followUp" | "steer"): Promise<void> {
  saveSettings({ deliverAs: value });
}

function registerSettingsOverlayKeybind(): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: "core-settings",
    action: "popup",
    defaultKey: "alt+/",
    description: "설정 오버레이 팝업 표시",
    category: "Core",
    handler: async (ctx) => {
      await openSettingsPopup(ctx);
    },
  });
}

function registerPushModeSettingsSection(): void {
  const settingsApi = getInfraSettingsFacadeOrNull()?.getSettingsService();
  settingsApi?.registerSection({
    key: SECTION_KEY,
    displayName: "Push Mode",
    getDisplayFields() {
      const deliverAs = getDeliverAs();
      return [
        {
          label: "Deliver As",
          value: deliverAs === "followUp" ? "Follow-up" : "Steer",
          color: deliverAs === "followUp" ? "accent" : "warning",
        },
      ];
    },
  });
}

async function openSettingsPopup(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  if (activePopup) return;

  const sections = getInfraSettingsFacadeOrNull()?.getSettingsService()?.getSections() ?? [];

  activePopup = ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) =>
      new SettingsOverlay(theme, sections, done),
    {
      overlay: true,
      overlayOptions: {
        width: "50%",
        maxHeight: "50%",
        anchor: "center",
        margin: 1,
      },
    },
  );

  try {
    await activePopup;
  } finally {
    activePopup = null;
  }
}

function getInfraSettingsFacade(): FleetInfraServices["settings"] {
  return getFleetRuntime().infra.settings;
}

function getInfraSettingsFacadeOrNull(): FleetInfraServices["settings"] | null {
  try {
    return getInfraSettingsFacade();
  } catch {
    return null;
  }
}
