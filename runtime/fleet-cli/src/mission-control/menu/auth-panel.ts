import type { AuthService } from "@dotobokuri/fleet-infra/auth";
import { CLI_TO_AUTH_PROVIDER_ID, createAuthService } from "@dotobokuri/fleet-infra/auth";

import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createInputModal } from "./input-modal.js";
import { isDown, isEnter, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface AuthPanelDeps {
  readonly authService?: AuthService;
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
}

interface ProviderRow {
  readonly providerId: string;
  readonly label: string;
  configured: boolean;
  status: string;
}

export function createAuthPanel(deps: AuthPanelDeps): MenuPanel {
  const authService = deps.authService ?? createAuthService();
  const rows = createProviderRows();
  let selected = 0;
  let loading = false;
  let message = "";

  void refresh();

  return {
    id: "fleet-menu:auth",
    title: "Authentication",
    handleInput(data: string): boolean {
      if (isUp(data)) {
        selected = move(selected, rows.length, -1);
        return true;
      }
      if (isDown(data)) {
        selected = move(selected, rows.length, 1);
        return true;
      }
      if (isEnter(data)) {
        const row = rows[selected];
        if (row !== undefined) {
          openKeyModal(row);
        }
        return true;
      }
      if (data === "D" || data === "d") {
        const row = rows[selected];
        if (row !== undefined && row.configured) {
          openDeleteModal(row);
        }
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      const lines = [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Authentication"), width),
        "",
        ...rows.map((row, index) => centerText(formatProviderRow(row, index === selected), width)),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter register or replace  D delete  Esc back"), width),
      ];
      if (loading) {
        lines.push(centerText(MISSION_CONTROL_THEME.dim("Refreshing..."), width));
      }
      if (message.length > 0) {
        lines.push(centerText(message, width));
      }
      return lines;
    },
  };

  async function refresh(): Promise<void> {
    loading = true;
    deps.onRenderRequest();
    try {
      const configured = new Set(await authService.listProviderIds());
      for (const row of rows) {
        row.configured = configured.has(row.providerId) || (await authService.getApiKey(row.providerId)) !== undefined;
        row.status = row.configured ? "Configured" : "Missing";
      }
      message = "";
    } catch (error: unknown) {
      message = MISSION_CONTROL_THEME.error(formatError(error));
    } finally {
      loading = false;
      deps.onRenderRequest();
    }
  }

  function openKeyModal(row: ProviderRow): void {
    deps.stack.push(createInputModal({
      title: row.label,
      message: row.configured ? "Replace stored API key." : "Register API key.",
      mode: "password",
      onRenderRequest: deps.onRenderRequest,
      placeholder: "API key",
      validate: (value) => value.trim().length === 0 ? "API key is required." : undefined,
      onCancel: () => {
        deps.stack.pop();
      },
      onSubmit: async (value) => {
        await authService.setApiKey(row.providerId, value);
        deps.stack.pop();
        await refresh();
      },
    }));
  }

  function openDeleteModal(row: ProviderRow): void {
    deps.stack.push(createInputModal({
      title: `Delete ${row.label}`,
      message: "Delete stored API key?",
      mode: "confirm",
      onRenderRequest: deps.onRenderRequest,
      onCancel: () => {
        deps.stack.pop();
      },
      onSubmit: async () => {
        await authService.deleteApiKey(row.providerId);
        deps.stack.pop();
        await refresh();
      },
    }));
  }
}

function createProviderRows(): ProviderRow[] {
  return Object.entries(CLI_TO_AUTH_PROVIDER_ID)
    .map(([cliId, providerId]) => ({
      configured: false,
      label: formatCliLabel(cliId),
      providerId,
      status: "Checking",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function formatProviderRow(row: ProviderRow, selected: boolean): string {
  const marker = selected ? "▸" : " ";
  const status = row.configured ? MISSION_CONTROL_THEME.success(row.status) : MISSION_CONTROL_THEME.warning(row.status);
  return `${marker} ${row.label}  ${status}`;
}

function formatCliLabel(cliId: string): string {
  return cliId
    .split("-")
    .map((part) => part.length > 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part)
    .join(" ");
}

function move(index: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Authentication action failed.";
}
