import * as React from "react";

import { OperationBody } from "@fleet-console/sdk/operations/browser";
import { createClientCapabilities, defineOperationKind, definePlugin, usePluginApi, usePluginStorage } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { defineSettingsSection, SettingsCard, SettingsField, SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

interface NotesInfo {
  readonly name: string;
  readonly version: number;
}

const NOTES_PLUGIN_ID = "notes";
const NOTES_OPERATION_TYPE = "notes";

export default definePlugin({
  id: NOTES_PLUGIN_ID,
  operationKinds: [
    defineOperationKind({
      pluginId: NOTES_PLUGIN_ID,
      type: NOTES_OPERATION_TYPE,
      title: "Notes",
      subtitle: (operation) => operation.title,
      render: (ctx) => <NotesOperationPanel ctx={ctx} />,
    }),
  ],
  settingsSections: [
    defineSettingsSection({
      id: "general",
      title: "Notes",
      render: () => <NotesSettings />,
    }),
  ],
  launch: (ctx) => ctx.operations.createRoot({
    theaterId: ctx.theaterId,
    type: NOTES_OPERATION_TYPE,
    pluginId: NOTES_PLUGIN_ID,
    title: "Notes",
    payload: {},
    geometry: ctx.geometry,
  }),
  renderLaunchIcon: () => (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 3h9l3 3v15H6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M15 3v4h4M9 11h6M9 15h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
});

function NotesOperationPanel({ ctx }: { readonly ctx: OperationRenderContext }): React.ReactElement {
  const api = usePluginApi(ctx.api, ctx.pluginId);
  const [note, setNote] = usePluginStorage(ctx.preferences, `notes:${ctx.operationId}`, "");
  const [info, setInfo] = React.useState<NotesInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void api.fetch("/info")
      .then((response) => response.json() as Promise<NotesInfo>)
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <OperationBody className="notes-plugin-panel">
      <div className="notes-plugin-panel__meta">
        {info ? `${info.name} v${info.version}` : "Notes"}
      </div>
      <label className="notes-plugin-panel__label" htmlFor={`notes-${ctx.operationId}`}>
        Operation note
      </label>
      <textarea
        id={`notes-${ctx.operationId}`}
        className="notes-plugin-panel__textarea"
        value={note}
        placeholder="Capture a local note for this Operation."
        onChange={(event) => setNote(event.currentTarget.value)}
      />
    </OperationBody>
  );
}

function NotesSettings(): React.ReactElement {
  const caps = React.useMemo(() => createClientCapabilities(), []);
  const [enabled, setEnabled] = usePluginStorage(caps.preferences, "notes:settings:enabled", true);

  return (
    <SettingsCard title="Notes" description="Configure the sample external Notes plugin.">
      <SettingsRow label="Enable notes panel" hint="Persists through the SDK preferences capability.">
        <SettingsToggle checked={enabled} onChange={setEnabled} label="Enabled" />
      </SettingsRow>
      <SettingsField label="Storage key" hint="Sample plugins can keep browser-local preferences without host state.">
        <code>notes:settings:enabled</code>
      </SettingsField>
    </SettingsCard>
  );
}
