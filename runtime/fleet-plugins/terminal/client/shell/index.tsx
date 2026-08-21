import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { definePlugin, React } from "@fleet-console/sdk/plugin/browser";
import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import { ShellGlyph } from "@fleet-console/sdk/components/shell-glyph";
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
  launch: async ({ theaterId, operations, geometry }) => {
    const operation = await operations.create({
      theaterId,
      type: "shell",
      pluginId: "terminal",
      title: getT("en")("terminal.kind.shell"),
      payload: { theaterId },
      geometry,
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
  const [relaunchFailed, setRelaunchFailed] = React.useState(false);
  const restoredDormant = context.operation.payload.restoredDormant === true && !relaunched;
  const relaunch = () => {
    setRelaunchFailed(false);
    void context.api.fetch("terminal", `shell/sessions/${encodeURIComponent(context.operationId)}/relaunch`, { method: "POST" })
      .then((response) => {
        if (!response.ok) throw new Error("shell_relaunch_failed");
        setRelaunched(true);
        context.api.resync();
      })
      // 예전에는 이 자리가 빈 catch였다 — 재기동이 거절돼도 카드는 그대로라, 누른 사람에게는
      // 버튼이 반응하지 않는 것처럼 보였다.
      .catch(() => setRelaunchFailed(true));
  };
  if (restoredDormant) {
    // 실패한 뒤에는 카드를 알림으로 갈아 끼운다. 버튼 안에 다시 버튼을 넣으면 활성화 대상이
    // 둘로 갈린다.
    if (relaunchFailed) {
      return (
        <div className="canvas-operation-dormant-failure">
          <FailureNotice
            title={t("terminal.failure.relaunch.title")}
            cause={t("terminal.failure.relaunch.cause")}
            actions={[{ label: t("terminal.failure.relaunch.retry"), onSelect: relaunch, primary: true }]}
            tone="coral"
          />
        </div>
      );
    }
    return (
      <button type="button" className="canvas-operation-dormant" onClick={relaunch}>
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
