import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";

import type { HostSelection, HostView, HostWorkspacePort, HostWorkspaceSnapshot } from "@fleet-console/sdk/host-context";
import type { Translate } from "@fleet-console/sdk/i18n";
import "./host-workspace.css";

export type HostWorkspaceMessageKey =
  | "hosts.workspace.local" | "hosts.workspace.remote" | "hosts.workspace.viewing"
  | "hosts.workspace.connected" | "hosts.workspace.connecting" | "hosts.workspace.disconnected"
  | "hosts.workspace.untrusted" | "hosts.workspace.blocked" | "hosts.workspace.loading"
  | "hosts.workspace.summary" | "hosts.workspace.commander" | "hosts.workspace.commodore" | "hosts.workspace.commodoreRole"
  | "hosts.workspace.commanders" | "hosts.workspace.awaiting" | "hosts.workspace.empty"
  | "hosts.workspace.all" | "hosts.workspace.filter" | "hosts.workspace.returnLocal"
  | "hosts.workspace.readOnly" | "hosts.workspace.observing" | "hosts.workspace.localTools"
  | "hosts.workspace.loadFailed" | "hosts.workspace.trustHelp" | "hosts.workspace.connectionHelp"
  | "hosts.workspace.controlPending" | "hosts.workspace.selectConversation"
  | "hosts.workspace.running" | "hosts.workspace.idle" | "hosts.workspace.background" | "hosts.workspace.ended" | "hosts.workspace.unknown"
  | "hosts.workspace.quotaSource" | "hosts.workspace.controlHeld" | "hosts.workspace.retryObservation";

type HostTranslate = Translate<HostWorkspaceMessageKey>;

interface HostWorkspaceProps {
  readonly hosts: HostWorkspacePort;
  readonly t: HostTranslate;
}

function useHostWorkspace(hosts: HostWorkspacePort): HostWorkspaceSnapshot {
  return useSyncExternalStore(hosts.subscribe, hosts.getSnapshot, hosts.getSnapshot);
}

function hostStatus(host: HostView, t: HostTranslate): string {
  if (host.trust === "mismatch") return t("hosts.workspace.untrusted");
  if (host.connection === "blocked") return t("hosts.workspace.blocked");
  if (host.connection === "closed" || host.phase === "error") return t("hosts.workspace.disconnected");
  if (host.connection === "connecting" || host.phase === "loading" || host.phase === "idle") return t("hosts.workspace.connecting");
  return t("hosts.workspace.connected");
}

function sameSelection(a: HostSelection, b: HostSelection): boolean {
  return a.hostKey === b.hostKey && a.theaterId === b.theaterId && a.role === b.role && a.operationId === b.operationId;
}

function ComputerGlyph({ local }: { readonly local: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="3" y="3.5" width="14" height="10" rx="1.5" />
    {local ? <path d="M1.5 16h17" /> : <path d="M10 13.5V17M6.5 17h7" />}
  </svg>;
}

/** 접힘과 필터는 표시 상태다. 전경 활성화는 대화 행에서만 요청한다. */
export function HostWorkspaceSidebar({ hosts, t }: HostWorkspaceProps) {
  const state = useHostWorkspace(hosts);
  const id = useId();
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({ local: true, [state.selection.hostKey]: true });
  const [filters, setFilters] = useState<Readonly<Record<string, string | null>>>({});
  const [activationFailed, setActivationFailed] = useState(false);
  const selectedHost = state.hosts.find((host) => host.hostKey === state.selection.hostKey);
  const selectedFilter = filters[state.selection.hostKey] ?? null;
  const validFilter = selectedHost?.theaters.some((theater) => theater.id === selectedFilter) ? selectedFilter : null;

  useEffect(() => {
    setExpanded((current) => ({ ...current, [state.selection.hostKey]: true }));
    setActivationFailed(false);
  }, [state.selection.hostKey]);

  const activate = (selection: HostSelection) => {
    setActivationFailed(false);
    const pending = hosts.activateConversation(selection);
    const generation = hosts.getSnapshot().selectionGeneration;
    void pending.catch(() => {
      const current = hosts.getSnapshot();
      if (current.selectionGeneration === generation && sameSelection(current.selection, selection)) setActivationFailed(true);
    });
  };

  return <div className="host-workspace-sidebar">
    <div className="host-workspace-computers" aria-label={t("hosts.workspace.selectConversation")}>
      {state.hosts.map((host, index) => {
        const local = host.hostKey === "local";
        const selected = host.hostKey === state.selection.hostKey;
        const open = expanded[host.hostKey] === true;
        const ready = host.phase === "ready";
        const blocked = host.connection === "blocked" || host.connection === "closed" || host.trust === "mismatch";
        const usable = ready && host.connection === "ready" && (local || host.trust === "verified");
        const filter = selected ? validFilter : null;
        const operations = host.operations.filter((operation) => !operation.parentOperationId && (local || operation.type === "agent"));
        const bodyId = `${id}-computer-${index}`;
        return <section key={host.hostKey} className="host-workspace-computer" data-selected={selected} data-blocked={blocked} aria-labelledby={`${bodyId}-head`}>
          <button id={`${bodyId}-head`} type="button" className="host-workspace-computer-head" aria-expanded={open} aria-controls={bodyId}
            onClick={() => setExpanded((current) => ({ ...current, [host.hostKey]: !open }))}>
            <svg className="host-workspace-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
            <ComputerGlyph local={local} />
            <span className="host-workspace-computer-names"><span>{t(local ? "hosts.workspace.local" : "hosts.workspace.remote")}</span><strong>{host.label}</strong></span>
            <span className="host-workspace-reach" data-connection={host.connection} data-trust={host.trust}>{selected ? t("hosts.workspace.viewing") : hostStatus(host, t)}</span>
            {!open ? <span className="host-workspace-summary">{ready ? <>{t("hosts.workspace.summary", { commodores: host.theaters.length, commanders: operations.length })}{selected ? ` · ${hostStatus(host, t)}` : ""}</> : hostStatus(host, t)}</span> : null}
          </button>
          <div id={bodyId} hidden={!open} className="host-workspace-computer-body" aria-busy={!ready && !blocked}>
            {selected ? <p className="host-workspace-connection">{hostStatus(host, t)}{host.access === "monitoring" ? ` · ${t("hosts.workspace.readOnly")}` : ""}</p> : null}
            {!local && host.mode === "controller" ? <p className="host-workspace-connection">{t("hosts.workspace.controlHeld")}</p> : null}
            {!ready && !blocked ? <p className="host-workspace-note" role="status">{t("hosts.workspace.loading", { host: host.label })}</p> : null}
            {(ready ? host.theaters : []).filter((theater) => !filter || theater.id === filter).map((theater) => {
              const theaterOperations = operations.filter((operation) => operation.theaterId === theater.id);
              const waiting = theaterOperations.filter((operation) => operation.activity === "awaiting").length;
              const target: HostSelection = { hostKey: host.hostKey, theaterId: theater.id, role: "commodore", operationId: null };
              return <div key={theater.id} className="host-workspace-theater">
                <button type="button" className="host-workspace-commodore" disabled={!usable} aria-current={sameSelection(state.selection, target) ? "true" : undefined}
                  onClick={() => activate(target)}>
                  <span className="host-workspace-theater-avatar" aria-hidden="true">{Array.from(theater.alias || theater.label).slice(0, 2).join("").toLocaleUpperCase()}</span>
                  <span className="host-workspace-row-copy"><strong>{t("hosts.workspace.commodore", { theater: theater.alias || theater.label })}</strong>
                    <span>{t("hosts.workspace.commanders", { count: theaterOperations.length })}{waiting ? <span className="host-workspace-waiting"> · {t("hosts.workspace.awaiting", { count: waiting })}</span> : null}</span>
                  </span>
                </button>
                {theaterOperations.map((operation) => {
                  const target: HostSelection = { hostKey: host.hostKey, theaterId: theater.id, role: "commander", operationId: operation.id };
                  return <button key={operation.id} type="button" className="host-workspace-commander" disabled={!usable}
                    aria-current={sameSelection(state.selection, target) ? "true" : undefined} onClick={() => activate(target)}>
                    <span className="host-workspace-activity" data-activity={operation.activity ?? "unknown"} role="img" aria-label={t(`hosts.workspace.${operation.activity === "awaiting" ? "awaiting" : operation.activity ?? "unknown"}`, { count: 1 })} />
                    <span className="host-workspace-operation-title">{operation.title}</span>
                  </button>;
                })}
              </div>;
            })}
            {ready && host.theaters.length === 0 ? <p className="host-workspace-note">{t("hosts.workspace.empty")}</p> : null}
            {blocked ? <div className="host-workspace-note"><p>{t(host.trust === "mismatch" ? "hosts.workspace.trustHelp" : "hosts.workspace.connectionHelp")}</p>
              {!local && host.trust !== "mismatch" ? <button type="button" className="host-workspace-back" onClick={() => hosts.select({ hostKey: host.hostKey, theaterId: null, role: "commodore", operationId: null })}>{t("hosts.workspace.retryObservation")}</button> : null}
              {!local ? <button type="button" className="host-workspace-back" onClick={hosts.returnLocal}>{t("hosts.workspace.returnLocal")}</button> : null}
            </div> : null}
          </div>
        </section>;
      })}
      {activationFailed ? <p className="host-workspace-note" role="alert">{t("hosts.workspace.loadFailed")}</p> : null}
    </div>
    <div className="host-workspace-tray" role="group" aria-label={t("hosts.workspace.filter", { host: selectedHost?.label ?? "" })}>
      <div className="host-workspace-tray-heading"><span>Theater</span><strong>{selectedHost?.label}</strong></div>
      <div className="host-workspace-filters">
        <button type="button" aria-pressed={!validFilter} onClick={() => setFilters((current) => ({ ...current, [state.selection.hostKey]: null }))}>{t("hosts.workspace.all")}</button>
        {selectedHost?.theaters.map((theater) => <button type="button" key={theater.id} aria-pressed={validFilter === theater.id}
          onClick={() => setFilters((current) => ({ ...current, [state.selection.hostKey]: theater.id }))}>{theater.alias || theater.label}</button>)}
      </div>
    </div>
  </div>;
}

/** 호스트 관리·보관함 등 기존 로컬 전용 도구는 원격 대화의 동작으로 보이지 않게 구획한다. */
export function HostLocalTools({ hosts, children, t, notice = false }: HostWorkspaceProps & { readonly children: ReactNode; readonly notice?: boolean }) {
  const state = useHostWorkspace(hosts);
  return state.selection.hostKey === "local" ? <>{children}</> : notice ? <span className="host-workspace-local-tools">{t("hosts.workspace.localTools")}</span> : null;
}

export function HostWorkspaceLocation({ hosts, t, rail = false, conversationTitle = true }: HostWorkspaceProps & { readonly rail?: boolean; readonly conversationTitle?: boolean }) {
  const state = useHostWorkspace(hosts);
  const host = state.hosts.find((host) => host.hostKey === state.selection.hostKey);
  if (!host) return null;
  const theater = host.theaters.find((theater) => theater.id === state.selection.theaterId);
  const operation = state.selection.role === "commander" ? host.operations.find((item) => item.id === state.selection.operationId && item.theaterId === state.selection.theaterId) : null;
  return <div className={`host-workspace-location${rail ? " is-rail-caption" : ""}`} role="group" aria-label={t("hosts.workspace.viewing")} data-host-key={host.hostKey} data-theater-id={state.selection.theaterId ?? undefined}>
    <span className="host-workspace-location-host"><ComputerGlyph local={host.hostKey === "local"} />{host.label}</span>
    {theater ? <><span aria-hidden="true">›</span><span>{theater.alias || theater.label}</span>{!rail ? <span className="host-workspace-role">{t(state.selection.role === "commodore" ? "hosts.workspace.commodoreRole" : "hosts.workspace.commander")}</span> : null}</> : null}
    {!rail && conversationTitle && operation ? <strong className="host-workspace-conversation-title" title={operation.title}>{operation.title}</strong> : null}
    {!rail && !state.canWrite ? <span className="host-workspace-mode">{t(state.phase === "loading" ? "hosts.workspace.controlPending" : host.access === "monitoring" ? "hosts.workspace.readOnly" : "hosts.workspace.observing")}</span> : null}
  </div>;
}

/** 본문을 가릴지의 판단은 scope 소유자가 한다. canWrite=false는 읽기 본문을 가리지 않는다. */
export function HostWorkspaceState({ hosts, t }: HostWorkspaceProps) {
  const state = useHostWorkspace(hosts);
  const host = state.hosts.find((host) => host.hostKey === state.selection.hostKey);
  if (!host || state.foreground !== null) return null;
  const failed = state.phase === "error" || host.connection === "blocked" || host.connection === "closed" || host.trust === "mismatch";
  return <div className="host-workspace-state" role="status" aria-busy={!failed && state.phase === "loading"}>
    <strong>{failed ? t(host.trust === "mismatch" ? "hosts.workspace.untrusted" : "hosts.workspace.loadFailed") : state.phase === "idle" ? t("hosts.workspace.selectConversation") : t("hosts.workspace.loading", { host: host.label })}</strong>
    {failed ? <p>{t(host.trust === "mismatch" ? "hosts.workspace.trustHelp" : "hosts.workspace.connectionHelp")}</p> : null}
    {host.hostKey !== "local" ? <button type="button" className="host-workspace-back" onClick={hosts.returnLocal}>{t("hosts.workspace.returnLocal")}</button> : null}
  </div>;
}

export function HostWorkspaceDockLabel({ hosts, t }: HostWorkspaceProps) {
  const state = useHostWorkspace(hosts);
  const host = state.hosts.find((host) => host.hostKey === state.selection.hostKey);
  return <div className="host-workspace-dock-label"><span>{t("hosts.workspace.viewing")}</span><strong>{host?.label}</strong>
    {state.selection.hostKey !== "local" ? <button type="button" className="host-workspace-back" onClick={hosts.returnLocal}>{t("hosts.workspace.returnLocal")}</button> : null}
  </div>;
}
