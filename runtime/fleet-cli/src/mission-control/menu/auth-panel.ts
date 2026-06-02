import type { AuthService } from "@dotobokuri/fleet-infra/auth";
import { CLI_TO_AUTH_PROVIDER_ID } from "@dotobokuri/fleet-infra/auth";

import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createActionListPanel } from "./action-list-panel.js";
import { createInputModal } from "./input-modal.js";
import { isDown, isEnter, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

// [MEDIUM #6] authService 필수 주입 — Composition Root 보장. fallback 무인자 생성 제거
export interface AuthPanelDeps {
  readonly authService: AuthService;
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
  const authService = deps.authService;
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
          openProviderActions(row);
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
        centerText(MISSION_CONTROL_THEME.dim("Enter actions  Esc back"), width),
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
    deps.stack.push(createActionListPanel({
      id: `auth:delete:${row.providerId}`,
      title: `Delete ${row.label}`,
      statusLines: () => [MISSION_CONTROL_THEME.warning("Delete stored API key?")],
      onBack: () => {
        deps.stack.pop();
      },
      actions: [
        {
          id: "cancel",
          label: "Cancel",
          run: () => {
            deps.stack.pop();
          },
        },
        {
          id: "confirm",
          label: "Confirm",
          run: () => {
            void authService.deleteApiKey(row.providerId).then(async () => {
              deps.stack.pop();
              await refresh();
            });
          },
        },
      ],
    }));
  }

  function openProviderActions(row: ProviderRow): void {
    deps.stack.push(createActionListPanel({
      id: `auth:actions:${row.providerId}`,
      title: row.label,
      breadcrumbs: () => deps.stack.breadcrumbs(),
      onBack: () => {
        deps.stack.pop();
      },
      actions: () => [
        {
          id: "key",
          label: row.configured ? "Replace API Key" : "Register API Key",
          run: () => {
            openKeyModal(row);
          },
        },
        row.configured && {
          id: "delete",
          label: "Delete API Key",
          run: () => {
            openDeleteModal(row);
          },
        },
      ],
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
  const marker = selected ? MISSION_CONTROL_THEME.accent("▸") : MISSION_CONTROL_THEME.dim(" ");
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(row.label)) : row.label;
  const status = row.configured ? MISSION_CONTROL_THEME.success(row.status) : MISSION_CONTROL_THEME.warning(row.status);
  return `${marker} ${label}  ${status}`;
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
