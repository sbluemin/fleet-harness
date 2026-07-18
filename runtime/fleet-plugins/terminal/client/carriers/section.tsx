import { useEffect, useState, type CSSProperties } from "react";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";

import {
  loadCarrierSettings,
  resetCarrierSettingsDraft,
  saveCarrierAll,
  selectCarrierSettingsCarrier,
  updateCarrierSettingsDraft,
  updateCarrierSettingsTaskForceDraft,
  useCarrierSettingsStore,
} from "./store.js";
import type { CarrierSettingsCarrier, CarrierSettingsCliOption, CarrierSettingsModelOption } from "../../shared/carrier-settings-types.js";

type CaptainColorStyle = CSSProperties & { "--cap-color": string };
type SaveStatus = "idle" | "saving" | "saved";

interface CarrierSettingsDraftView {
  readonly cliType: string;
  readonly model: string;
  readonly effort: string;
  readonly displayName: string;
  readonly taskforce: Readonly<Record<string, { readonly model: string; readonly effort: string }>>;
}

const DISPLAY_NAME_MAX_LENGTH = 50;
const SAVE_FEEDBACK_DURATION_MS = 2400;
const CAPTAIN_COLOR_TOKENS: Readonly<Record<string, string>> = {
  nimitz: "var(--captain-nimitz)",
  kirov: "var(--captain-kirov)",
  genesis: "var(--captain-genesis)",
  ohio: "var(--captain-ohio)",
  sentinel: "var(--captain-sentinel)",
  vanguard: "var(--captain-vanguard)",
  tempest: "var(--captain-tempest)",
  chronicle: "var(--captain-chronicle)",
};

export const carrierSettingsSection = defineSettingsSection({
  id: "carriers",
  title: "Carriers",
  render: () => <CarrierSettingsSection />,
});

function CarrierSettingsSection() {
  const settings = useCarrierSettingsStore();
  const activeCarrier = settings.state?.carriers.find((carrier) => carrier.carrierId === settings.activeCarrierId) ?? null;
  const activeCli = settings.options?.cliTypes.find((cli) => cli.id === settings.draft.cliType) ?? null;
  const activeModel = activeCli?.models.find((model) => model.modelId === settings.draft.model) ?? null;
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [taskForceRows, setTaskForceRows] = useState<readonly string[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const isSavingAll = settings.savingActionId === "save-all";
  const dirty = activeCarrier ? hasCarrierDraftChanges(activeCarrier, settings.draft, taskForceRows) : false;
  const taskForceConfigKey = activeCarrier?.taskforce.backends.map((backend) => `${backend.cliType}:${backend.model}:${backend.effort ?? ""}`).join("|") ?? "";

  useEffect(() => {
    const controller = new AbortController();
    void loadCarrierSettings(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setEditingDisplayName(false);
    setTaskForceRows(activeCarrier?.taskforce.backends.map((backend) => backend.cliType) ?? []);
    setSaveStatus("idle");
  }, [activeCarrier?.carrierId, taskForceConfigKey]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timeout = window.setTimeout(() => setSaveStatus("idle"), SAVE_FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  function handleDiscard(): void {
    if (!activeCarrier) return;
    resetCarrierSettingsDraft();
    setTaskForceRows(activeCarrier.taskforce.backends.map((backend) => backend.cliType));
    setEditingDisplayName(false);
    setSaveStatus("idle");
  }

  async function handleSave(): Promise<void> {
    if (!activeCarrier) return;
    setSaveStatus("saving");
    const saved = await saveCarrierAll(buildDesiredTaskForce(taskForceRows, settings.draft.taskforce));
    if (!saved) {
      setSaveStatus("idle");
      return;
    }
    setEditingDisplayName(false);
    setSaveStatus("saved");
  }

  return (
    <>
      {settings.error ? <p className="terminal-carriers-error" role="alert">{settings.error}</p> : null}

      <div className="terminal-carriers-strip" role="group" aria-label="Carrier list">
        {settings.loading && !settings.state ? <p className="terminal-carriers-empty">Loading carrier settings.</p> : null}
        {settings.state && settings.state.carriers.length === 0 ? <p className="terminal-carriers-empty">No carriers registered.</p> : null}
        {settings.state?.carriers.map((carrier) => (
          <CarrierChip
            key={carrier.carrierId}
            carrier={carrier}
            active={carrier.carrierId === settings.activeCarrierId}
            minBackends={settings.options?.taskForceConstraints.minBackends ?? null}
            onSelect={() => selectCarrierSettingsCarrier(carrier.carrierId)}
          />
        ))}
      </div>

      {activeCarrier && settings.options && activeCli ? (
        <section key={activeCarrier.carrierId} className="global-settings-card terminal-carriers-card" style={getCaptainColorStyle(activeCarrier.carrierId)}>
            <div className="terminal-carriers-detail-head">
              <div className="terminal-carriers-detail-title-block">
                <div className="terminal-carriers-captain-id"><span>Captain</span> · {activeCarrier.carrierId.toUpperCase()}</div>
                <div className={`terminal-carriers-name-line ${editingDisplayName ? "is-editing" : ""}`}>
                  {editingDisplayName ? (
                    <>
                      <input
                        id="carrier-display-name"
                        className="terminal-carriers-input terminal-carriers-name-input"
                        aria-label="Display name"
                        value={settings.draft.displayName}
                        maxLength={DISPLAY_NAME_MAX_LENGTH}
                        onChange={(event) => updateCarrierSettingsDraft({ displayName: event.target.value })}
                      />
                      <button type="button" className="terminal-carriers-icon-button" aria-label="Save display name" disabled={isSavingAll} onClick={() => {
                        setEditingDisplayName(false);
                      }}>
                        <CheckIcon />
                      </button>
                      <button type="button" className="terminal-carriers-icon-button" aria-label="Cancel display name edit" onClick={() => {
                        updateCarrierSettingsDraft({ displayName: activeCarrier.displayName });
                        setEditingDisplayName(false);
                      }}>
                        <CloseIcon />
                      </button>
                    </>
                  ) : (
                    <>
                      <h3 className="terminal-carriers-captain-name">{activeCarrier.displayName}</h3>
                      <button type="button" className="terminal-carriers-icon-button" aria-label="Edit display name" onClick={() => {
                        updateCarrierSettingsDraft({ displayName: activeCarrier.displayName });
                        setEditingDisplayName(true);
                      }}>
                        <PencilIcon />
                      </button>
                    </>
                  )}
                </div>
                <div className="terminal-carriers-captain-role">{activeCarrier.role}</div>
              </div>
              <div className="terminal-carriers-detail-actions">
                <div className={`terminal-carriers-save-status ${saveStatus === "saved" ? "is-positive" : ""}`} role="status" aria-live="polite">
                  {saveStatus === "saving" || isSavingAll ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : ""}
                </div>
                <div className="terminal-carriers-save-actions">
                  <button type="button" className={`terminal-carriers-action-button ${dirty ? "is-dirty" : ""}`} disabled={!dirty || isSavingAll} onClick={() => void handleSave()}>
                    Save
                  </button>
                  <button type="button" className={`terminal-carriers-action-button ${dirty ? "is-dirty" : ""}`} disabled={!dirty || isSavingAll} onClick={handleDiscard}>
                    Discard
                  </button>
                  <button type="button" className="terminal-carriers-action-button terminal-carriers-detail-refresh" disabled={settings.loading} onClick={() => void loadCarrierSettings()}>
                    Refresh
                  </button>
                </div>
              </div>
            </div>

            <div className="terminal-carriers-body">
              <div className="terminal-carriers-control-group">
                <div className="terminal-carriers-resp-title">Identity</div>
                <div className="terminal-carriers-mission">{activeCarrier.roleDescription}</div>
              </div>

              <div className="terminal-carriers-control-group">
                <div className="terminal-carriers-resp-title">Runtime</div>
                <div className="terminal-carriers-runtime">
                  <div className="terminal-carriers-runtime-row terminal-carriers-runtime-row--cli">
                    <div className="terminal-carriers-field terminal-carriers-field--wide">
                      <label className="terminal-carriers-label" htmlFor="carrier-cli">CLI</label>
                      <select
                        id="carrier-cli"
                        className="terminal-carriers-select"
                        value={settings.draft.cliType}
                        onChange={(event) => handleCliDraftChange(event.target.value, settings.options?.cliTypes ?? [])}
                      >
                        {settings.options.cliTypes.map((cli) => <option key={cli.id} value={cli.id}>{cli.displayName}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="terminal-carriers-runtime-row terminal-carriers-runtime-row--model">
                    <ModelSelect
                      id="carrier-model"
                      label="Model"
                      models={activeCli.models}
                      value={settings.draft.model}
                      onChange={(modelId) => handleModelDraftChange(activeCli, modelId)}
                    />
                    <EffortSelect
                      id="carrier-effort"
                      model={activeModel}
                      value={settings.draft.effort}
                      onChange={(effort) => updateCarrierSettingsDraft({ effort })}
                    />
                  </div>
                </div>
              </div>

              {activeCarrier.taskForceCapable ? (
                <TaskForcePanel
                  carrier={activeCarrier}
                  cliOptions={settings.options.cliTypes}
                  minBackends={settings.options.taskForceConstraints.minBackends}
                  savingActionId={settings.savingActionId}
                  rows={taskForceRows}
                  onRowsChange={setTaskForceRows}
                />
              ) : null}
            </div>
        </section>
      ) : (
        <section className="global-settings-card terminal-carriers-card">
          <p className="terminal-carriers-empty">Select a carrier.</p>
          {/* 선택된 함장이 없어도 로스터 재조회 경로는 남겨 둔다. */}
          <button type="button" className="terminal-carriers-action-button" disabled={settings.loading} onClick={() => void loadCarrierSettings()}>
            Refresh
          </button>
        </section>
      )}
    </>
  );
}

function CarrierChip({ carrier, active, minBackends, onSelect }: { readonly carrier: CarrierSettingsCarrier; readonly active: boolean; readonly minBackends: number | null; readonly onSelect: () => void }) {
  const tfReady = carrier.taskForceCapable && minBackends !== null && carrier.taskforce.backends.length >= minBackends;
  return (
    <button type="button" className={`terminal-carriers-chip ${active ? "is-active" : ""}`} aria-pressed={active} style={getCaptainColorStyle(carrier.carrierId)} onClick={onSelect}>
      <span className="terminal-carriers-captain-dot" aria-hidden="true" />
      <span className="terminal-carriers-chip-name">{carrier.displayName}</span>
      {tfReady ? <span className="terminal-carriers-live-dot is-live" aria-hidden="true" /> : null}
    </button>
  );
}

function ModelSelect({ id, label, models, value, disabled = false, onChange }: { readonly id: string; readonly label: string; readonly models: readonly CarrierSettingsModelOption[]; readonly value: string; readonly disabled?: boolean; readonly onChange: (modelId: string) => void }) {
  return (
    <div className="terminal-carriers-field">
      <label className="terminal-carriers-label" htmlFor={id}>{label}</label>
      <select id={id} className="terminal-carriers-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
      </select>
    </div>
  );
}

function EffortSelect({ id, model, value, disabled = false, onChange }: { readonly id: string; readonly model: CarrierSettingsModelOption | null | undefined; readonly value: string; readonly disabled?: boolean; readonly onChange: (effort: string) => void }) {
  if (!model?.effort) {
    return (
      <div className="terminal-carriers-field">
        <span className="terminal-carriers-label">Effort</span>
        <p className="terminal-carriers-help">Not supported for this model.</p>
      </div>
    );
  }
  return (
    <div className="terminal-carriers-field">
      <label className="terminal-carriers-label" htmlFor={id}>Effort</label>
      <select id={id} className="terminal-carriers-select" value={value || model.effort.default} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {model.effort.levels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </div>
  );
}

function TaskForcePanel({
  carrier,
  cliOptions,
  minBackends,
  savingActionId,
  rows,
  onRowsChange,
}: {
  readonly carrier: CarrierSettingsCarrier;
  readonly cliOptions: readonly CarrierSettingsCliOption[];
  readonly minBackends: number;
  readonly savingActionId: string | null;
  readonly rows: readonly string[];
  readonly onRowsChange: (rows: readonly string[]) => void;
}) {
  const settings = useCarrierSettingsStore();
  // 구성된 백엔드가 있으면 기본 펼침, 없으면 접힘. detail이 carrierId로 remount되어 캐리어별로 재초기화된다.
  const configuredCount = carrier.taskforce.backends.length;
  const [expanded, setExpanded] = useState(configuredCount > 0);
  const [addOpen, setAddOpen] = useState(false);
  const [addCliType, setAddCliType] = useState("");
  const active = carrier.taskforce.backends.length >= minBackends;
  const availableCliOptions = cliOptions.filter((cli) => !rows.includes(cli.id));
  const selectedAddCliType = addCliType || availableCliOptions[0]?.id || "";
  return (
    <div className={`terminal-carriers-control-group terminal-carriers-control-group--taskforce ${expanded ? "is-expanded" : ""}`}>
      <div className="terminal-carriers-section-head">
        <div>
          <p className="terminal-carriers-resp-title">Task Force</p>
          <p className="terminal-carriers-help">
            {configuredCount > 0
              ? `${configuredCount} backend${configuredCount === 1 ? "" : "s"} configured${active ? " · active" : ` · needs ${minBackends}+ to activate`}.`
              : `Run this carrier across multiple CLI backends. Needs at least ${minBackends} to activate.`}
          </p>
        </div>
        <div className="terminal-carriers-tf-head-actions">
          <button type="button" className="terminal-carriers-tf-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide" : "Configure"}
          </button>
        </div>
      </div>
      {expanded ? (
      <div className="terminal-carriers-tf-list">
        {rows.length === 0 ? <p className="terminal-carriers-tf-empty">No Task Force backend drafted.</p> : null}
        {rows.map((cliType) => {
          const cli = cliOptions.find((item) => item.id === cliType);
          if (!cli) return null;
          const draft = settings.draft.taskforce[cli.id] ?? { model: cli.defaultModel, effort: "" };
          const model = cli.models.find((item) => item.modelId === draft.model) ?? cli.models[0] ?? null;
          const active = carrier.taskforce.backends.some((backend) => backend.cliType === cli.id);
          return (
            <div className={`terminal-carriers-tf-item ${active ? "is-active" : ""}`} key={cli.id}>
              <div className="terminal-carriers-tf-title">
                <span className={`terminal-carriers-live-dot ${active ? "is-live" : ""}`} aria-hidden="true" />
                <strong>{cli.displayName}</strong>
              </div>
              <ModelSelect id={`tf-${cli.id}-model`} label="Model" models={cli.models} value={draft.model} onChange={(modelId) => handleTaskForceModelDraftChange(cli, modelId)} />
              <EffortSelect id={`tf-${cli.id}-effort`} model={model} value={draft.effort} onChange={(effort) => updateCarrierSettingsTaskForceDraft(cli.id, { effort })} />
              <div className="terminal-carriers-tf-actions">
                <button type="button" className="terminal-carriers-ghost-button" disabled={savingActionId === "save-all"} onClick={() => onRowsChange(rows.filter((item) => item !== cli.id))}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
        <div className="terminal-carriers-tf-add-row">
          {addOpen && availableCliOptions.length > 0 ? (
            <select className="terminal-carriers-select terminal-carriers-tf-add-select" value={selectedAddCliType} onChange={(event) => setAddCliType(event.target.value)} aria-label="Task Force CLI to add">
              {availableCliOptions.map((cli) => <option key={cli.id} value={cli.id}>{cli.displayName}</option>)}
            </select>
          ) : null}
          <button type="button" className="terminal-carriers-ghost-button" disabled={availableCliOptions.length === 0 || savingActionId === "save-all"} onClick={() => {
            if (!addOpen) {
              setAddOpen(true);
              return;
            }
            const cliType = selectedAddCliType;
            const cli = cliOptions.find((item) => item.id === cliType);
            const model = cli?.models.find((item) => item.modelId === cli.defaultModel) ?? cli?.models[0] ?? null;
            if (!cli || !model) return;
            updateCarrierSettingsTaskForceDraft(cli.id, { model: model.modelId, effort: model.effort?.default ?? "" });
            onRowsChange(rows.includes(cli.id) ? rows : [...rows, cli.id]);
            setAddCliType("");
            setAddOpen(false);
          }}>
            Add
          </button>
        </div>
      </div>
      ) : null}
    </div>
  );
}

function handleCliDraftChange(cliType: string, cliOptions: readonly CarrierSettingsCliOption[]): void {
  const cli = cliOptions.find((item) => item.id === cliType);
  const model = cli?.models.find((item) => item.modelId === cli.defaultModel) ?? cli?.models[0] ?? null;
  updateCarrierSettingsDraft({
    cliType,
    model: model?.modelId ?? "",
    effort: model?.effort?.default ?? "",
  });
}

function handleModelDraftChange(cli: CarrierSettingsCliOption, modelId: string): void {
  const model = cli.models.find((item) => item.modelId === modelId);
  updateCarrierSettingsDraft({
    model: modelId,
    effort: model?.effort?.default ?? "",
  });
}

function handleTaskForceModelDraftChange(cli: CarrierSettingsCliOption, modelId: string): void {
  const model = cli.models.find((item) => item.modelId === modelId);
  updateCarrierSettingsTaskForceDraft(cli.id, {
    model: modelId,
    effort: model?.effort?.default ?? "",
  });
}

function hasCarrierDraftChanges(carrier: CarrierSettingsCarrier, draft: CarrierSettingsDraftView, rows: readonly string[]): boolean {
  if (draft.displayName !== carrier.displayName) return true;
  if (draft.cliType !== carrier.cliType) return true;
  if (draft.model !== carrier.model) return true;
  if ((draft.effort || "") !== (carrier.effort || "")) return true;
  return hasTaskForceChanges(carrier, rows, draft.taskforce);
}

function hasTaskForceChanges(carrier: CarrierSettingsCarrier, rows: readonly string[], draft: Readonly<Record<string, { readonly model: string; readonly effort: string }>>): boolean {
  if (rows.length !== carrier.taskforce.backends.length) return true;
  const rowSet = new Set(rows);
  for (const backend of carrier.taskforce.backends) {
    if (!rowSet.has(backend.cliType)) return true;
    const selection = draft[backend.cliType];
    if (!selection) return true;
    if (selection.model !== backend.model) return true;
    if ((selection.effort || "") !== (backend.effort || "")) return true;
  }
  return false;
}

function buildDesiredTaskForce(rows: readonly string[], draft: CarrierSettingsDraftView["taskforce"]): readonly { readonly cliType: string; readonly model: string; readonly effort?: string }[] {
  return rows
    .map((cliType) => {
      const selection = draft[cliType];
      return selection ? {
        cliType,
        model: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {}),
      } : null;
    })
    .filter((backend): backend is { readonly cliType: string; readonly model: string; readonly effort?: string } => backend !== null);
}

function getCaptainColorStyle(carrierId: string): CaptainColorStyle {
  return { "--cap-color": CAPTAIN_COLOR_TOKENS[carrierId] ?? "var(--brass)" };
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10.8 2.2 13.8 5.2 5.2 13.8 2 14.5 2.7 11.3 10.8 2.2Z" />
      <path d="M9.7 3.4 12.6 6.3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8.3 6.4 11.7 13.2 4.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.2 4.2 11.8 11.8" />
      <path d="M11.8 4.2 4.2 11.8" />
    </svg>
  );
}
