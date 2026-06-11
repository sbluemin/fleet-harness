import { createGatewayDaemonLifecycle } from "@dotobokuri/fleet-gateway";

import { renderKeyValueBlock, type KeyValueBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../theme.js";
import { centerText } from "../welcome.js";
import { createActionListPanel } from "./action-list-panel.js";
import { isEnter, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface GatewayProcessController {
  readonly getStatus: () => GatewayStatus;
  readonly start: () => void;
  readonly stop: () => void;
  readonly restart: () => void;
}

export interface GatewayPanelDeps {
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
  readonly gateway?: GatewayProcessController;
}

export type GatewayStatus =
  | { readonly state: "stopped"; readonly lastHealth?: string }
  | { readonly state: "starting"; readonly lastHealth?: string }
  | { readonly state: "running"; readonly endpoint: string; readonly pid?: number; readonly tenantCount?: number; readonly buildStale?: boolean; readonly lastHealth?: string }
  | { readonly state: "error"; readonly message: string; readonly lastHealth?: string };

export function createGatewayProcessController(options: { readonly onChange: () => void }): GatewayProcessController {
  const lifecycle = createGatewayDaemonLifecycle();
  let status: GatewayStatus = { state: "stopped" };

  void refresh();

  async function refresh(): Promise<void> {
    const probe = await lifecycle.probe();
    if (probe.healthy && probe.health) {
      status = {
        state: "running",
        endpoint: probe.health.endpoint,
        pid: probe.health.pid,
        tenantCount: probe.health.tenantCount,
        buildStale: probe.buildStale,
        lastHealth: new Date().toISOString(),
      };
      options.onChange();
    }
  }

  return {
    getStatus: () => status,
    start(): void {
      if (status.state === "starting") return;
      status = { state: "starting", lastHealth: status.lastHealth };
      options.onChange();
      void lifecycle.ensureDaemon()
        .then(() => refresh())
        .catch((error: unknown) => {
          status = { state: "error", message: formatError(error), lastHealth: status.lastHealth };
          options.onChange();
        });
    },
    stop(): void {
      void lifecycle.stop()
        .then(() => {
          status = { state: "stopped", lastHealth: new Date().toISOString() };
          options.onChange();
        })
        .catch((error: unknown) => {
          status = { state: "error", message: formatError(error), lastHealth: status.lastHealth };
          options.onChange();
        });
      status = { state: "stopped", lastHealth: status.lastHealth };
      options.onChange();
    },
    restart(): void {
      status = { state: "starting", lastHealth: status.lastHealth };
      options.onChange();
      void lifecycle.stop()
        .then(() => lifecycle.ensureDaemon())
        .then(() => refresh())
        .catch((error: unknown) => {
          status = { state: "error", message: formatError(error), lastHealth: status.lastHealth };
          options.onChange();
        });
    },
  };
}

export function createGatewayPanel(deps: GatewayPanelDeps): MenuPanel {
  const gateway = deps.gateway ?? createGatewayProcessController({ onChange: deps.onRenderRequest });

  return {
    id: "fleet-menu:gateway",
    title: "Gateway Status",
    handleInput(data: string): boolean {
      if (isEnter(data)) {
        openGatewayActions();
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      const status = gateway.getStatus();
      return [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Gateway Status"), width),
        "",
        centerText(formatStatus(status), width),
        ...renderInfoRows(buildRows(status), width),
        "",
        centerText(formatActionsRow(), width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter actions  Esc back"), width),
      ];
    },
  };

  function openGatewayActions(): void {
    deps.stack.push(createActionListPanel({
      id: "gateway:actions",
      title: "Gateway Actions",
      breadcrumbs: () => deps.stack.breadcrumbs(),
      onBack: () => deps.stack.pop(),
      actions: () => [
        {
          id: "start",
          label: gateway.getStatus().state === "running" ? "Refresh Gateway" : "Start Gateway",
          run: () => {
            gateway.start();
            deps.onRenderRequest();
          },
        },
        {
          id: "restart",
          label: "Restart Gateway",
          run: () => {
            gateway.restart();
            deps.onRenderRequest();
          },
        },
        gateway.getStatus().state === "running" && {
          id: "stop",
          label: "Stop Gateway",
          run: () => {
            gateway.stop();
            deps.onRenderRequest();
          },
        },
      ],
    }));
  }
}

function buildRows(status: GatewayStatus): KeyValueBlockRow[] {
  return [
    { key: "Endpoint", value: status.state === "running" ? MISSION_CONTROL_THEME.accent(status.endpoint) : MISSION_CONTROL_THEME.dim("unavailable") },
    { key: "PID", value: status.state === "running" && status.pid !== undefined ? String(status.pid) : MISSION_CONTROL_THEME.dim("none") },
    { key: "Tenants", value: status.state === "running" && status.tenantCount !== undefined ? String(status.tenantCount) : MISSION_CONTROL_THEME.dim("unknown") },
    { key: "Build", value: status.state === "running" && status.buildStale ? MISSION_CONTROL_THEME.warning("stale (restart deferred)") : status.state === "running" ? "current" : MISSION_CONTROL_THEME.dim("unknown") },
    { key: "Pending Calls", value: MISSION_CONTROL_THEME.dim("in memory") },
    { key: "Observer Status", value: status.state === "running" ? "available" : MISSION_CONTROL_THEME.dim("unavailable") },
    { key: "Last Health", value: status.lastHealth ?? MISSION_CONTROL_THEME.dim("not checked") },
  ];
}

function renderInfoRows(rows: KeyValueBlockRow[], width: number): string[] {
  return renderKeyValueBlock({ innerWidth: width, rows });
}

function formatActionsRow(): string {
  return `${MISSION_CONTROL_THEME.accent("▸")} ${MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent("Actions"))}`;
}

function formatStatus(status: GatewayStatus): string {
  if (status.state === "running") return MISSION_CONTROL_THEME.success("running");
  if (status.state === "starting") return MISSION_CONTROL_THEME.warning("starting");
  if (status.state === "error") return MISSION_CONTROL_THEME.error(status.message);
  return MISSION_CONTROL_THEME.dim("stopped");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
