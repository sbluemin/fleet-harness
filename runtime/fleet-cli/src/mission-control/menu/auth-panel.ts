import type { AuthService } from "@dotobokuri/core-infra";

import { AUTH_CLI_DEFINITIONS } from "../../auth/login-flow.js";
import type { AuthCliId } from "../../auth/types.js";

import { renderChoiceBlock, type ChoiceBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createActionListPanel } from "./action-list-panel.js";
import { createInputModal } from "./input-modal.js";
import { isDown, isEnter, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface AuthPanelDeps {
  readonly authService: AuthService;
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
}

interface ProviderRow {
  readonly cli: AuthCliId;
  readonly providerId: string;
  readonly label: string;
  readonly shortName: string;
  configured: boolean;
  status: string;
}

export function createAuthPanel(deps: AuthPanelDeps): MenuPanel {
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
        if (row) openProviderActions(row);
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
        ...renderProviderRows(rows, selected, width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter actions  Esc back"), width),
      ];
      if (loading) lines.push(centerText(MISSION_CONTROL_THEME.dim("Refreshing..."), width));
      if (message) lines.push(centerText(message, width));
      return lines;
    },
  };

  async function refresh(): Promise<void> {
    loading = true;
    deps.onRenderRequest();
    try {
      const configured = new Set(await deps.authService.listProviderIds());
      for (const row of rows) {
        row.configured = configured.has(row.providerId);
        row.status = row.configured ? "Configured" : "Missing";
      }
      message = "";
    } catch (error) {
      message = MISSION_CONTROL_THEME.error(formatError(error));
    } finally {
      loading = false;
      deps.onRenderRequest();
    }
  }

  function openKeyModal(row: ProviderRow): void {
    deps.stack.push(createInputModal({
      title: row.label,
      message: row.configured ? "Validate and replace the stored API key." : "Validate and register an API key.",
      mode: "password",
      onRenderRequest: deps.onRenderRequest,
      placeholder: "API key",
      validate: (value) => value.trim() ? undefined : "API key is required.",
      onCancel: () => deps.stack.pop(),
      onSubmit: async (value) => {
        const validation = await AUTH_CLI_DEFINITIONS[row.cli].validate(value.trim());
        if (validation.status !== "success") {
          throw new Error(formatValidationFailure(row.shortName, validation.status));
        }
        await deps.authService.setApiKey(row.providerId, value.trim());
        deps.stack.pop();
        await refresh();
      },
    }));
  }

  function openDeleteModal(row: ProviderRow): void {
    deps.stack.push(createActionListPanel({
      id: `auth:delete:${row.cli}`,
      title: `Delete ${row.label}`,
      statusLines: () => [MISSION_CONTROL_THEME.warning("Delete stored API key?")],
      onBack: () => deps.stack.pop(),
      actions: [
        { id: "cancel", label: "Cancel", run: () => deps.stack.pop() },
        {
          id: "confirm",
          label: "Confirm",
          run: () => {
            void deps.authService.deleteApiKey(row.providerId).then(async () => {
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
      id: `auth:actions:${row.cli}`,
      title: row.label,
      breadcrumbs: () => deps.stack.breadcrumbs(),
      onBack: () => deps.stack.pop(),
      actions: () => [
        {
          id: "key",
          label: row.configured ? "Replace API Key" : "Register API Key",
          run: () => openKeyModal(row),
        },
        row.configured && {
          id: "delete",
          label: "Delete API Key",
          run: () => openDeleteModal(row),
        },
      ],
    }));
  }
}

function createProviderRows(): ProviderRow[] {
  return (Object.keys(AUTH_CLI_DEFINITIONS) as AuthCliId[]).map((cli) => ({
    cli,
    configured: false,
    label: AUTH_CLI_DEFINITIONS[cli].label,
    shortName: AUTH_CLI_DEFINITIONS[cli].shortName,
    providerId: AUTH_CLI_DEFINITIONS[cli].providerId,
    status: "Checking",
  }));
}

function renderProviderRows(rows: readonly ProviderRow[], selected: number, width: number): string[] {
  return renderChoiceBlock({
    innerWidth: width,
    rows: rows.map((row, index) => formatProviderRow(row, index === selected)),
  });
}

function formatProviderRow(row: ProviderRow, selected: boolean): ChoiceBlockRow {
  const marker = selected ? MISSION_CONTROL_THEME.accent("▸") : MISSION_CONTROL_THEME.dim(" ");
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(row.label)) : row.label;
  const status = row.configured ? MISSION_CONTROL_THEME.success(row.status) : MISSION_CONTROL_THEME.warning(row.status);
  return { label, marker, trailing: status };
}

function move(index: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function formatValidationFailure(shortName: string, status: string): string {
  if (status === "unauthorized") return `${shortName} rejected the API key.`;
  if (status === "forbidden") return `The API key is not allowed for ${shortName}.`;
  if (status === "timeout") return `${shortName} API key validation timed out.`;
  if (status === "network") return `Could not reach ${shortName}.`;
  if (status === "server") return `${shortName} returned an error. Try again later.`;
  return `Could not validate the ${shortName} API key.`;
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Authentication action failed.";
}
