import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { definePlugin, React } from "@fleet-console/sdk/plugin/browser";
import { getT } from "../i18n/index.js";
import { TerminalSurface } from "../shared/index.js";

const SHELL_TICKET_PATH = "/plugins/terminal/shell/ticket";
const SHELL_WS_PATH = "/plugins/terminal/ws";

export const shellOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "shell",
  title: (locale) => getT(locale)("terminal.kind.shell"),
  subtitle: () => "shell",
  render: (context) => React.createElement(ShellOperationView, { context }),
});

export const shellPlugin = definePlugin({
  id: "terminal",
  operationKinds: [shellOperationKind],
  install: () => undefined,
  closeOperation: async (operationId) => {
    await fetch(`/plugins/terminal/shell/sessions/${encodeURIComponent(operationId)}`, { method: "DELETE" });
  },
  launch: async ({ theaterId, operations }) => {
    const operation = await operations.create({
      theaterId,
      type: "shell",
      pluginId: "terminal",
      title: getT("en")("terminal.kind.shell"),
      payload: { theaterId },
    });
    return { id: operation.id };
  },
  renderLaunchIcon: () => <ShellGlyph />,
});

export const operationKinds = [shellOperationKind] as const;
export const plugins = [shellPlugin] as const;

function ShellOperationView({ context }: { readonly context: OperationRenderContext }) {
  const t = getT(context.language ?? "en");
  const [relaunched, setRelaunched] = React.useState(false);
  const restoredDormant = context.operation.payload.restoredDormant === true && !relaunched;
  if (restoredDormant) {
    return (
      <button type="button" className="canvas-operation-dormant" onClick={() => {
        void context.api.fetch("terminal", `shell/sessions/${encodeURIComponent(context.operationId)}/relaunch`, { method: "POST" })
          .then((response) => {
            if (!response.ok) throw new Error("shell_relaunch_failed");
            setRelaunched(true);
            context.api.resync();
          })
          .catch(() => {});
      }}>
        <span className="canvas-operation-dormant-status">{t("terminal.dormant.status")}</span>
        <span className="canvas-operation-dormant-action">{t("terminal.shell.relaunch")}</span>
      </button>
    );
  }
  return (
    <TerminalSurface
      operationId={context.operationId}
      active={context.active}
      keyboardFocusRequestId={context.keyboardFocusRequestId}
      zoom={context.zoom}
      ticketPath={SHELL_TICKET_PATH}
      wsPath={SHELL_WS_PATH}
      theme={context.theme}
      locale={context.language}
      onStatusDetail={(detail) => context.statusDetail.set(context.operationId, detail)}
      onExit={context.onClose}
    />
  );
}

function ShellGlyph() {
  // 순정 셸 — 화면+프롬프트 stroke 마크. 셸 플러그인이 자기 드롭다운 아이콘을 소유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.8" y="3.4" width="10.4" height="9.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.15" />
      <path d="M5 6.6 6.8 8.4 5 10.2M8.4 10.2h2.8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
