import {
  openFleetWikiWorkspace,
  probeFleetWikiDaemon,
  stopDaemon as stopFleetWikiDaemon,
} from "@dotobokuri/fleet-wiki-ui/cli";
import type { OpenFleetWikiWorkspaceResult } from "@dotobokuri/fleet-wiki-ui/cli";

import { renderKeyValueBlock, type KeyValueBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createActionListPanel } from "./action-list-panel.js";
import { createInputModal } from "./input-modal.js";
import { isEnter, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface WikiProcessController {
  readonly getPort: () => number;
  readonly getStatus: () => WikiServerStatus;
  readonly setPort: (port: number) => void;
  readonly start: () => void;
  readonly stop: () => void;
}

export interface WikiPanelDeps {
  readonly cwd: string;
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
  readonly wiki?: WikiProcessController;
}

export interface CreateWikiProcessControllerOptions {
  readonly cwd: string;
  readonly onChange: () => void;
  readonly openWorkspace?: (options: {
    readonly cwd: string;
    readonly port?: number;
  }) => Promise<OpenFleetWikiWorkspaceResult>;
  readonly probe?: (options: {
    readonly cwd: string;
  }) => Promise<OpenFleetWikiWorkspaceResult | null>;
  readonly stopDaemon?: () => Promise<void>;
}

export type WikiServerStatus =
  | { readonly state: "stopped"; readonly message?: string }
  | { readonly state: "starting"; readonly port: number; readonly pid?: number }
  | { readonly state: "running"; readonly host?: string; readonly port: number; readonly pid?: number }
  | { readonly state: "error"; readonly message: string };

const DEFAULT_WIKI_PORT = 3737;

export function createWikiProcessController(options: CreateWikiProcessControllerOptions): WikiProcessController {
  let port = DEFAULT_WIKI_PORT;
  let status: WikiServerStatus = { state: "stopped" };
  let requestId = 0;
  const openWorkspace = options.openWorkspace ?? openFleetWikiWorkspace;
  const probe = options.probe ?? probeFleetWikiDaemon;
  const stopDaemon = options.stopDaemon ?? stopFleetWikiDaemon;

  void (async () => {
    try {
      const currentRequestId = requestId;
      const result = await probe({ cwd: options.cwd });
      if (requestId !== currentRequestId || status.state !== "stopped" || result === null) {
        return;
      }
      port = result.port;
      status = { state: "running", host: result.host, port: result.port, pid: result.pid };
      options.onChange();
    } catch {
      // 초기 probe 실패는 UX 노이즈를 피하고 다음 Enter의 helper 흐름에 맡긴다.
    }
  })();

  return {
    getPort: () => status.state === "running" ? status.port : port,
    getStatus: () => status,
    setPort: (nextPort) => {
      port = nextPort;
    },
    start(): void {
      // starting 상태에서는 helper 호출이 이미 진행 중이므로 중복 dispatch를 막는다.
      // running 상태에서는 helper를 다시 호출해 healthy daemon을 재사용하면서 브라우저만 다시 연다.
      if (status.state === "starting") {
        return;
      }
      const currentRequestId = ++requestId;
      const wasRunning = status.state === "running";
      if (!wasRunning) {
        // stopped/error에서만 시각적으로 starting으로 전환한다. running에서는 깜빡임을 피한다.
        status = { state: "starting", port };
        options.onChange();
      }

      void (async () => {
        try {
          // 테스트는 daemon 프로세스를 띄우지 않고 helper 경계만 대체한다.
          const result = await openWorkspace({ cwd: options.cwd, port });
          if (requestId !== currentRequestId) return;
          port = result.port;
          status = { state: "running", host: result.host, port: result.port, pid: result.pid };
        } catch (error: unknown) {
          if (requestId !== currentRequestId) return;
          status = { state: "error", message: formatError(error) };
        }
        options.onChange();
      })();
    },
    stop(): void {
      const currentRequestId = ++requestId;
      void (async () => {
        try {
          await stopDaemon();
          if (requestId !== currentRequestId) return;
          status = { state: "stopped" };
        } catch (error: unknown) {
          if (requestId !== currentRequestId) return;
          status = { state: "error", message: formatError(error) };
        }
        options.onChange();
      })();
      status = { state: "stopped" };
      options.onChange();
    },
  };
}

export function createWikiPanel(deps: WikiPanelDeps): MenuPanel {
  const wiki = deps.wiki ?? createWikiProcessController({ cwd: deps.cwd, onChange: deps.onRenderRequest });

  return {
    id: "fleet-menu:wiki",
    title: "Wiki Server",
    handleInput(data: string): boolean {
      if (isEnter(data)) {
        openWikiActions();
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      const status = wiki.getStatus();
      const infoRows = [
        { key: "Port", value: MISSION_CONTROL_THEME.accent(String(wiki.getPort())) },
      ];
      return [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Wiki Server"), width),
        "",
        centerText(formatStatus(status), width),
        ...renderInfoRows(infoRows, width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("External fleet wiki processes are not managed here."), width),
        "",
        centerText(formatActionsRow(), width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter actions  Esc back"), width),
      ];
    },
  };

  function openWikiActions(): void {
    deps.stack.push(createActionListPanel({
      id: "wiki:actions",
      title: "Wiki Server Actions",
      breadcrumbs: () => deps.stack.breadcrumbs(),
      onBack: () => {
        deps.stack.pop();
      },
      actions: () => {
        const status = wiki.getStatus();
        const canStop = status.state === "running" || status.state === "starting";
        return [
          {
            id: "open",
            label: status.state === "running" ? "Reopen Workspace" : "Open Workspace",
            run: () => {
              wiki.start();
              deps.onRenderRequest();
            },
          },
          canStop && {
            id: "stop",
            label: "Stop Server",
            run: () => {
              wiki.stop();
              deps.onRenderRequest();
            },
          },
          {
            id: "port",
            label: "Set Port",
            run: () => {
              openPortModal();
            },
          },
        ];
      },
    }));
  }

  function openPortModal(): void {
    deps.stack.push(createInputModal({
      title: "Wiki Server Port",
      message: "Set port for this Fleet process.",
      mode: "numeric",
      initialValue: String(wiki.getPort()),
      onRenderRequest: deps.onRenderRequest,
      validate: validatePort,
      onCancel: () => {
        deps.stack.pop();
      },
      onSubmit: (value) => {
        wiki.setPort(Number(value));
        deps.stack.pop();
      },
    }));
  }
}

function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return "Use port 1024-65535";
  }
  return undefined;
}

function formatStatus(status: WikiServerStatus): string {
  if (status.state === "starting") {
    return MISSION_CONTROL_THEME.warning(`starting :${status.port}`);
  }
  if (status.state === "running") {
    const host = status.host ?? "127.0.0.1";
    const pid = status.pid === undefined ? "" : ` pid ${status.pid}`;
    return MISSION_CONTROL_THEME.success(`running ${host}:${status.port}${pid}`);
  }
  if (status.state === "error") {
    return MISSION_CONTROL_THEME.error(status.message);
  }
  return MISSION_CONTROL_THEME.warning("stopped");
}

function formatActionsRow(): string {
  return `${MISSION_CONTROL_THEME.accent("▸")} ${MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent("Actions"))}`;
}

function renderInfoRows(rows: readonly KeyValueBlockRow[], width: number): string[] {
  return renderKeyValueBlock({ innerWidth: width, rows });
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Wiki server failed.";
}
