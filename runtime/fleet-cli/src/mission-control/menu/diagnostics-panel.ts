import * as os from "node:os";
import * as path from "node:path";
import { getFleetDataDir } from "@dotobokuri/fleet-infra/data-dir";
import type { PresetService } from "@dotobokuri/fleet-infra/preset";

import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createInputModal } from "./input-modal.js";
import { isDown, isEnter, isEscape, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface DiagnosticsPanelDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onPresetReset?: () => void;
  readonly onRenderRequest: () => void;
  readonly presetService?: PresetService;
  readonly stack: PanelStack;
}

type DiagnosticsView = "root" | "data" | "system";

const ROOT_ROWS = ["Data Dir", "Reset Preset To Defaults", "System Info"] as const;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const LINE_BREAK_CHARS = /[\r\n]+/g;

export function createDiagnosticsPanel(deps: DiagnosticsPanelDeps): MenuPanel {
  let selected = 0;
  let view: DiagnosticsView = "root";
  let scroll = 0;
  let message = "";

  return {
    id: "fleet-menu:diagnostics",
    title: "Diagnostics",
    handleInput(data: string): boolean {
      if (view !== "root") {
        if (isEscape(data)) {
          view = "root";
          scroll = 0;
          return true;
        }
        if (isUp(data)) {
          scroll = Math.max(0, scroll - 1);
          return true;
        }
        if (isDown(data)) {
          scroll += 1;
          return true;
        }
        return false;
      }
      if (isUp(data)) {
        selected = move(selected, ROOT_ROWS.length, -1);
        return true;
      }
      if (isDown(data)) {
        selected = move(selected, ROOT_ROWS.length, 1);
        return true;
      }
      if (isEnter(data)) {
        openSelected();
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      if (view === "data") {
        return renderDataDir(width);
      }
      if (view === "system") {
        return renderSystemInfo(width);
      }
      const lines = [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Diagnostics"), width),
        "",
        ...ROOT_ROWS.map((row, index) => centerText(`${index === selected ? "▸" : " "} ${row}`, width)),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter open  Esc back"), width),
      ];
      if (message.length > 0) {
        lines.push(centerText(message, width));
      }
      return lines;
    },
  };

  function openSelected(): void {
    const row = ROOT_ROWS[selected];
    if (row === "Data Dir") {
      view = "data";
      return;
    }
    if (row === "System Info") {
      view = "system";
      return;
    }
    deps.stack.push(createInputModal({
      title: "Reset Preset To Defaults",
      message: "All CLI presets will be reset to defaults. Continue?",
      mode: "confirm",
      onRenderRequest: deps.onRenderRequest,
      onCancel: () => {
        deps.stack.pop();
      },
      onSubmit: () => {
        resetPresets();
        deps.stack.pop();
      },
    }));
  }


  function renderDataDir(width: number): readonly string[] {
    const dataDir = safeValue(getFleetDataDir);
    const cleanDataDir = sanitizeTerminalText(dataDir);
    return [
      "",
      centerText(MISSION_CONTROL_THEME.dim(`${renderBreadcrumbs(deps.stack.breadcrumbs())} / Data Dir`), width),
      centerText(MISSION_CONTROL_THEME.accent("Data Dir"), width),
      "",
      centerText(`Root: ${cleanDataDir}`, width),
      centerText(`Presets: ${sanitizeTerminalText(path.join(dataDir, "presets.json"))}`, width),
      "",
      centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
    ];
  }

  function renderSystemInfo(width: number): readonly string[] {
    return [
      "",
      centerText(MISSION_CONTROL_THEME.dim(`${renderBreadcrumbs(deps.stack.breadcrumbs())} / System Info`), width),
      centerText(MISSION_CONTROL_THEME.accent("System Info"), width),
      "",
      centerText(`Node: ${process.version}`, width),
      centerText(`OS: ${os.platform()} ${os.release()} ${os.arch()}`, width),
      centerText(`Shell: ${sanitizeTerminalText(deps.env.SHELL ?? "(unknown)")}`, width),
      centerText(`Terminal: ${sanitizeTerminalText(deps.env.TERM ?? "(unknown)")}`, width),
      centerText(`CWD: ${sanitizeTerminalText(deps.cwd)}`, width),
      "",
      centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
    ];
  }

  function resetPresets(): void {
    const preset = deps.presetService?.load();
    if (preset !== undefined) {
      for (const cliId of Object.keys(preset.byCli)) {
        deps.presetService?.resetCliPreset(cliId);
      }
      deps.presetService?.saveDefaultCliId(undefined);
    }
    deps.onPresetReset?.();
    message = MISSION_CONTROL_THEME.success("Preset defaults restored.");
  }

}

function safeValue(read: () => string): string {
  try {
    return read();
  } catch {
    return "(unavailable)";
  }
}


function move(index: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function sanitizeTerminalText(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(LINE_BREAK_CHARS, " ")
    .replace(CONTROL_CHARS, "");
}

function stripTerminalControlSequences(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscSequence(text, index);
      continue;
    }
    if (isC1Control(code)) {
      index = skipC1Sequence(text, index);
      continue;
    }

    result += text[index] ?? "";
    index++;
  }

  return result;
}

function skipEscSequence(text: string, index: number): number {
  const next = text.charCodeAt(index + 1);
  if (Number.isNaN(next)) return index + 1;

  if (next === 0x5b) return skipControlSequence(text, index + 2);
  if (next === 0x5d) return skipStringControl(text, index + 2, true);
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipStringControl(text, index + 2, false);
  }
  if (isEscIntermediate(next)) {
    let cursor = index + 1;
    while (cursor < text.length && isEscIntermediate(text.charCodeAt(cursor))) cursor++;
    return cursor < text.length ? cursor + 1 : cursor;
  }

  return index + 2;
}

function skipC1Sequence(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === 0x9b) return skipControlSequence(text, index + 1);
  if (code === 0x9d) return skipStringControl(text, index + 1, true);
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return skipStringControl(text, index + 1, false);
  }
  return index + 1;
}

function skipControlSequence(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipStringControl(text: string, index: number, allowBel: boolean): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (allowBel && code === 0x07) return cursor + 1;
    if (code === 0x9c) return cursor + 1;
    if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
    cursor++;
  }
  return cursor;
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function isEscIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}
