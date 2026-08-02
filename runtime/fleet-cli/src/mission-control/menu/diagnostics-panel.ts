import * as os from "node:os";
import { sanitizeOneLineText } from "@dotobokuri/fleet-carriers";
import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";

import { renderChoiceBlock, renderKeyValueBlock, type ChoiceBlockRow, type KeyValueBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createActionListPanel } from "./action-list-panel.js";
import { isDown, isEnter, isEscape, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface DiagnosticsPanelDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
}

type DiagnosticsView = "root" | "data" | "system";

const ROOT_ROWS = ["Data Dir", "System Info"] as const;

export function createDiagnosticsPanel(deps: DiagnosticsPanelDeps): MenuPanel {
  let selected = 0;
  let view: DiagnosticsView = "root";
  let scroll = 0;

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
      return [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Diagnostics"), width),
        "",
        ...renderRootRows(selected, width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter open  Esc back"), width),
      ];
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
  }


  function renderDataDir(width: number): readonly string[] {
    const dataDir = safeValue(getFleetDataDir);
    const cleanDataDir = sanitizeOneLineText(dataDir);
    const rows = [
      { key: "Root", value: MISSION_CONTROL_THEME.accent(cleanDataDir) },
    ];
    return [
      "",
      centerText(MISSION_CONTROL_THEME.dim(`${renderBreadcrumbs(deps.stack.breadcrumbs())} / Data Dir`), width),
      centerText(MISSION_CONTROL_THEME.accent("Data Dir"), width),
      "",
      ...renderInfoRows(rows, width),
      "",
      centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
    ];
  }

  function renderSystemInfo(width: number): readonly string[] {
    const rows = [
      { key: "Node", value: MISSION_CONTROL_THEME.accent(process.version) },
      { key: "OS", value: MISSION_CONTROL_THEME.accent(`${os.platform()} ${os.release()} ${os.arch()}`) },
      { key: "Shell", value: MISSION_CONTROL_THEME.accent(sanitizeOneLineText(deps.env.SHELL ?? "(unknown)")) },
      { key: "Terminal", value: MISSION_CONTROL_THEME.accent(sanitizeOneLineText(deps.env.TERM ?? "(unknown)")) },
      { key: "CWD", value: MISSION_CONTROL_THEME.accent(sanitizeOneLineText(deps.cwd)) },
    ];
    return [
      "",
      centerText(MISSION_CONTROL_THEME.dim(`${renderBreadcrumbs(deps.stack.breadcrumbs())} / System Info`), width),
      centerText(MISSION_CONTROL_THEME.accent("System Info"), width),
      "",
      ...renderInfoRows(rows, width),
      "",
      centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
    ];
  }

}

function renderInfoRows(rows: readonly KeyValueBlockRow[], width: number): string[] {
  return renderKeyValueBlock({ innerWidth: width, rows });
}

function renderRootRows(selected: number, width: number): string[] {
  return renderChoiceBlock({
    innerWidth: width,
    rows: ROOT_ROWS.map((row, index) => formatRootRow(row, index === selected)),
  });
}

function formatRootRow(row: string, selected: boolean): ChoiceBlockRow {
  const marker = selected ? MISSION_CONTROL_THEME.accent("▸") : MISSION_CONTROL_THEME.dim(" ");
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(row)) : row;
  return { label, marker };
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
