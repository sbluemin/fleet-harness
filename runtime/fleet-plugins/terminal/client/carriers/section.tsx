import { useEffect, useState, type CSSProperties } from "react";
import { Select } from "@fleet-console/sdk/react/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";

import {
  getCarrierSettingsStoreState,
  loadCarrierSettings,
  removeTaskForceBackend,
  saveCarrierPatch,
  saveTaskForceBackend,
  selectCarrierSettingsCarrier,
  useCarrierSettingsStore,
} from "./store.js";
import type { CarrierSettingsCarrier, CarrierSettingsCliOption, CarrierSettingsModelOption } from "../../shared/carrier-settings-types.js";

type CaptainColorStyle = CSSProperties & { "--cap-color": string };
type SaveStatus = "idle" | "saving" | "saved";
interface RuntimePendingSelections {
  readonly carrierId?: string;
  readonly cli?: string;
  readonly model?: string;
  readonly effort?: string;
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
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [pendingSelections, setPendingSelections] = useState<RuntimePendingSelections>({});
  const activePendingSelections = pendingSelections.carrierId === activeCarrier?.carrierId ? pendingSelections : {};
  const selectedCliType = activePendingSelections.cli ?? activeCarrier?.cliType;
  const activeCli = settings.options?.cliTypes.find((cli) => cli.id === selectedCliType) ?? null;
  const selectedModel = activePendingSelections.model ?? activeCarrier?.model;
  const activeModel = activeCli?.models.find((model) => model.modelId === selectedModel) ?? null;
  const isSaving = settings.savingActionId !== null;

  useEffect(() => {
    const controller = new AbortController();
    void loadCarrierSettings(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setEditingDisplayName(false);
    setDisplayName(activeCarrier?.displayName ?? "");
    setSaveStatus("idle");
    setPendingSelections({});
  }, [activeCarrier?.carrierId]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timeout = window.setTimeout(() => setSaveStatus("idle"), SAVE_FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  async function runCarrierSave(operation: () => Promise<boolean>): Promise<boolean> {
    const carrierId = getCarrierSettingsStoreState().activeCarrierId;
    setSaveStatus("saving");
    const saved = await operation();
    if (getCarrierSettingsStoreState().activeCarrierId === carrierId) {
      setPendingSelections({});
      setSaveStatus(saved ? "saved" : "idle");
    }
    return saved;
  }

  async function commitDisplayName(): Promise<void> {
    if (!activeCarrier || isSaving) return;
    setEditingDisplayName(false);
    if (displayName === activeCarrier.displayName) return;
    await runCarrierSave(() => saveCarrierPatch({ displayName }));
  }

  function cancelDisplayName(): void {
    setDisplayName(activeCarrier?.displayName ?? "");
    setEditingDisplayName(false);
  }

  async function handleCliChange(cliType: string): Promise<void> {
    const cli = settings.options?.cliTypes.find((item) => item.id === cliType);
    const model = cli?.models.find((item) => item.modelId === cli.defaultModel) ?? cli?.models[0] ?? null;
    if (!activeCarrier || !cli || !model) return;
    setPendingSelections({
      carrierId: activeCarrier.carrierId,
      cli: cliType,
      model: model.modelId,
      effort: model.effort?.default ?? "",
    });
    await runCarrierSave(() => saveCarrierPatch({
      cli: cliType,
      model: {
        model: model.modelId,
        ...(model.effort?.default ? { effort: model.effort.default } : {}),
      },
    }));
  }

  async function handleModelChange(modelId: string): Promise<void> {
    if (!activeCarrier) return;
    // 모델 전환 시 effort는 신 모델 기본값으로 리셋한다. 구 effort를 유지하면 effort 미지원/레벨 불일치
    // 모델에서 서버 readSelection이 400을 반환한다(구 draft 흐름의 리셋 동작과 동일 계약).
    const nextModel = activeCli?.models.find((model) => model.modelId === modelId) ?? null;
    setPendingSelections({
      carrierId: activeCarrier.carrierId,
      model: modelId,
      effort: nextModel?.effort?.default ?? "",
    });
    await runCarrierSave(() => saveCarrierPatch({
      model: {
        model: modelId,
        ...(nextModel?.effort?.default ? { effort: nextModel.effort.default } : {}),
      },
    }));
  }

  async function handleEffortChange(effort: string): Promise<void> {
    if (!activeCarrier) return;
    setPendingSelections({ carrierId: activeCarrier.carrierId, effort });
    await runCarrierSave(() => saveCarrierPatch({ model: { model: activeCarrier.model, effort } }));
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
                        value={displayName}
                        maxLength={DISPLAY_NAME_MAX_LENGTH}
                        disabled={isSaving}
                        onChange={(event) => setDisplayName(event.target.value)}
                        onBlur={(event) => {
                          const next = event.relatedTarget;
                          if (next instanceof HTMLElement && next.closest("[data-display-name-action]")) return;
                          void commitDisplayName();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitDisplayName();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelDisplayName();
                          }
                        }}
                      />
                      <button type="button" className="terminal-carriers-icon-button" data-display-name-action aria-label="Save display name" disabled={isSaving} onClick={() => void commitDisplayName()}>
                        <CheckIcon />
                      </button>
                      <button type="button" className="terminal-carriers-icon-button" data-display-name-action aria-label="Cancel display name edit" onClick={cancelDisplayName}>
                        <CloseIcon />
                      </button>
                    </>
                  ) : (
                    <>
                      <h3 className="terminal-carriers-captain-name">{activeCarrier.displayName}</h3>
                      <button type="button" className="terminal-carriers-icon-button" aria-label="Edit display name" disabled={isSaving} onClick={() => {
                        setDisplayName(activeCarrier.displayName);
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
                  {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : ""}
                </div>
                <div className="terminal-carriers-save-actions">
                  <button type="button" className="terminal-carriers-action-button terminal-carriers-detail-refresh" disabled={settings.loading || isSaving} onClick={() => void loadCarrierSettings()}>
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
                      <span className="terminal-carriers-label" id="carrier-cli-label">CLI</span>
                      <Select
                        aria-labelledby="carrier-cli-label"
                        value={activePendingSelections.cli ?? activeCarrier.cliType}
                        disabled={isSaving}
                        options={settings.options.cliTypes.map((cli) => ({ value: cli.id, label: cli.displayName }))}
                        onChange={(cliType) => void handleCliChange(cliType)}
                      />
                    </div>
                  </div>
                  <div className="terminal-carriers-runtime-row terminal-carriers-runtime-row--model">
                    <ModelSelect
                      id="carrier-model"
                      label="Model"
                      models={activeCli.models}
                      value={activePendingSelections.model ?? activeCarrier.model}
                      disabled={isSaving}
                      onChange={(modelId) => void handleModelChange(modelId)}
                    />
                    <EffortSelect
                      id="carrier-effort"
                      model={activeModel}
                      value={activePendingSelections.effort ?? activeCarrier.effort ?? ""}
                      disabled={isSaving}
                      onChange={(effort) => void handleEffortChange(effort)}
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
                  stateGeneration={settings.state?.generation ?? 0}
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
  const labelId = `${id}-label`;
  return (
    <div className="terminal-carriers-field">
      <span className="terminal-carriers-label" id={labelId}>{label}</span>
      <Select
        aria-labelledby={labelId}
        value={value}
        disabled={disabled}
        options={models.map((model) => ({ value: model.modelId, label: model.name }))}
        onChange={onChange}
      />
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
  const labelId = `${id}-label`;
  return (
    <div className="terminal-carriers-field">
      <span className="terminal-carriers-label" id={labelId}>Effort</span>
      <Select
        aria-labelledby={labelId}
        value={value || model.effort.default}
        disabled={disabled}
        options={model.effort.levels.map((level) => ({ value: level, label: level }))}
        onChange={onChange}
      />
    </div>
  );
}

function TaskForcePanel({
  carrier,
  cliOptions,
  minBackends,
  savingActionId,
  stateGeneration,
}: {
  readonly carrier: CarrierSettingsCarrier;
  readonly cliOptions: readonly CarrierSettingsCliOption[];
  readonly minBackends: number;
  readonly savingActionId: string | null;
  readonly stateGeneration: number;
}) {
  // 구성된 백엔드가 있으면 기본 펼침, 없으면 접힘. detail이 carrierId로 remount되어 캐리어별로 재초기화된다.
  const configuredCount = carrier.taskforce.backends.length;
  const [expanded, setExpanded] = useState(configuredCount > 0);
  const [addOpen, setAddOpen] = useState(false);
  const [addCliType, setAddCliType] = useState("");
  const [armedCliType, setArmedCliType] = useState<string | null>(null);
  const [rowStatuses, setRowStatuses] = useState<Readonly<Record<string, SaveStatus>>>({});
  const [pendingSelections, setPendingSelections] = useState<Readonly<Record<string, string>>>({});
  const active = carrier.taskforce.backends.length >= minBackends;
  const availableCliOptions = cliOptions.filter((cli) => !carrier.taskforce.backends.some((backend) => backend.cliType === cli.id));
  const selectedAddCliType = addCliType || availableCliOptions[0]?.id || "";
  const isSaving = savingActionId !== null;

  useEffect(() => {
    setArmedCliType(null);
  }, [stateGeneration]);

  useEffect(() => {
    if (!armedCliType) return;
    const clearArmForDifferentControl = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(`[data-remove-cli="${armedCliType}"]`)) setArmedCliType(null);
    };
    document.addEventListener("click", clearArmForDifferentControl, true);
    return () => document.removeEventListener("click", clearArmForDifferentControl, true);
  }, [armedCliType]);

  useEffect(() => {
    const savedCliTypes = Object.entries(rowStatuses)
      .filter(([, status]) => status === "saved")
      .map(([cliType]) => cliType);
    if (savedCliTypes.length === 0) return;
    const timeout = window.setTimeout(() => {
      setRowStatuses((current) => {
        const next = { ...current };
        for (const cliType of savedCliTypes) next[cliType] = "idle";
        return next;
      });
    }, SAVE_FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [rowStatuses]);

  async function saveBackend(
    cliType: string,
    model: string,
    effort: string,
    pending: Readonly<Record<string, string>> = {},
  ): Promise<boolean> {
    const carrierId = carrier.carrierId;
    setPendingSelections((current) => ({ ...current, ...pending }));
    setRowStatuses((current) => ({ ...current, [cliType]: "saving" }));
    const saved = await saveTaskForceBackend(cliType, {
      model,
      ...(effort ? { effort } : {}),
    });
    if (getCarrierSettingsStoreState().activeCarrierId === carrierId) {
      setPendingSelections({});
      setRowStatuses((current) => ({ ...current, [cliType]: saved ? "saved" : "idle" }));
      if (saved) setArmedCliType(null);
    }
    return saved;
  }

  async function handleBackendModelChange(cli: CarrierSettingsCliOption, modelId: string): Promise<void> {
    const backend = carrier.taskforce.backends.find((item) => item.cliType === cli.id);
    if (!backend) return;
    // Runtime과 동일 계약: 모델 전환 시 effort는 신 모델 기본값으로 리셋(서버 readSelection 400 방지).
    const nextModel = cli.models.find((item) => item.modelId === modelId) ?? null;
    const effort = nextModel?.effort?.default ?? "";
    await saveBackend(cli.id, modelId, effort, {
      [`tf:${cli.id}:model`]: modelId,
      [`tf:${cli.id}:effort`]: effort,
    });
  }

  async function handleBackendEffortChange(cliType: string, model: string, effort: string): Promise<void> {
    await saveBackend(cliType, model, effort, { [`tf:${cliType}:effort`]: effort });
  }

  async function handleRemove(cliType: string): Promise<void> {
    if (armedCliType !== cliType) {
      setArmedCliType(cliType);
      return;
    }
    const carrierId = carrier.carrierId;
    setRowStatuses((current) => ({ ...current, [cliType]: "saving" }));
    const removed = await removeTaskForceBackend(cliType);
    if (getCarrierSettingsStoreState().activeCarrierId === carrierId) {
      setPendingSelections({});
      setRowStatuses((current) => ({ ...current, [cliType]: removed ? "saved" : "idle" }));
      if (removed) setArmedCliType(null);
    }
  }

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
        {carrier.taskforce.backends.length === 0 ? <p className="terminal-carriers-tf-empty">No Task Force backend configured.</p> : null}
        {carrier.taskforce.backends.map((backend) => {
          const cli = cliOptions.find((item) => item.id === backend.cliType);
          if (!cli) return null;
          const modelValue = pendingSelections[`tf:${cli.id}:model`] ?? backend.model;
          const effortValue = pendingSelections[`tf:${cli.id}:effort`] ?? backend.effort ?? "";
          const model = cli.models.find((item) => item.modelId === modelValue) ?? cli.models[0] ?? null;
          const rowStatus = rowStatuses[cli.id] ?? "idle";
          const armed = armedCliType === cli.id;
          const removeLabel = carrier.taskforce.backends.length - 1 < minBackends
            ? "Confirm — TF deactivates"
            : "Confirm remove";
          return (
            <div className="terminal-carriers-tf-item is-active" key={cli.id}>
              <div className="terminal-carriers-tf-title">
                <span className={`terminal-carriers-live-dot ${active ? "is-live" : ""}`} aria-hidden="true" />
                <strong>{cli.displayName}</strong>
                <span className={`terminal-carriers-tf-status ${rowStatus === "saved" ? "is-positive" : ""}`} role="status" aria-live="polite">
                  {rowStatus === "saving" ? "Saving…" : rowStatus === "saved" ? "Saved ✓" : ""}
                </span>
              </div>
              <ModelSelect id={`tf-${cli.id}-model`} label="Model" models={cli.models} value={modelValue} disabled={isSaving} onChange={(modelId) => void handleBackendModelChange(cli, modelId)} />
              <EffortSelect id={`tf-${cli.id}-effort`} model={model} value={effortValue} disabled={isSaving} onChange={(effort) => void handleBackendEffortChange(cli.id, modelValue, effort)} />
              <div className="terminal-carriers-tf-actions">
                <button
                  type="button"
                  className={`terminal-carriers-ghost-button terminal-carriers-tf-remove ${armed ? "is-armed" : ""}`}
                  data-remove-cli={cli.id}
                  aria-label={armed ? `Confirm removal of ${cli.displayName} backend` : undefined}
                  disabled={isSaving}
                  onClick={() => void handleRemove(cli.id)}
                >
                  {armed ? removeLabel : "Remove"}
                </button>
              </div>
            </div>
          );
        })}
        <div className="terminal-carriers-tf-add-row">
          {addOpen && availableCliOptions.length > 0 ? (
            <select className="terminal-carriers-select terminal-carriers-tf-add-select" value={selectedAddCliType} disabled={isSaving} onChange={(event) => setAddCliType(event.target.value)} aria-label="Task Force CLI to add">
              {availableCliOptions.map((cli) => <option key={cli.id} value={cli.id}>{cli.displayName}</option>)}
            </select>
          ) : null}
          <button type="button" className="terminal-carriers-ghost-button" disabled={availableCliOptions.length === 0 || isSaving} onClick={() => {
            if (!addOpen) {
              setAddOpen(true);
              return;
            }
            const cliType = selectedAddCliType;
            const cli = cliOptions.find((item) => item.id === cliType);
            const model = cli?.models.find((item) => item.modelId === cli.defaultModel) ?? cli?.models[0] ?? null;
            if (!cli || !model) return;
            void saveBackend(cli.id, model.modelId, model.effort?.default ?? "").then((saved) => {
              if (!saved) return;
              setAddCliType("");
              setAddOpen(false);
            });
          }}>
            Add
          </button>
        </div>
      </div>
      ) : null}
    </div>
  );
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
