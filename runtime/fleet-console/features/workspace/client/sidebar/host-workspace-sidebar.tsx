import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

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
  | "hosts.workspace.quotaSource" | "hosts.workspace.controlHeld" | "hosts.workspace.retryObservation"
  | "hosts.workspace.pairNeeded" | "hosts.workspace.pairAction" | "hosts.workspace.pairConfirm" | "hosts.workspace.pairConfirmAction"
  | "hosts.workspace.pairCancel" | "hosts.workspace.pairBusy" | "hosts.workspace.pairLinkRequired" | "hosts.workspace.pairUnsupported"
  | "hosts.workspace.pairDeviceLimit" | "hosts.workspace.pairFailed";

/**
 * pair 거절 코드(shared 계약)를 사람이 할 다음 행동으로 접는다. 원문 코드는 화면에 싣지 않는다.
 * 옛 셸이 모르는 명령을 버려 끝난 시간 초과는 `remote_host_unavailable`로 오므로 "지원하지 않음"으로 단정하지 않는다 —
 * `host_unsupported`는 셸·원격이 명시적으로 지원하지 않는다고 답한 경우뿐이다.
 */
function pairFailureKey(code: string): HostWorkspaceMessageKey {
  if (code === "remote_link_required") return "hosts.workspace.pairLinkRequired";
  if (code === "host_unsupported") return "hosts.workspace.pairUnsupported";
  if (code === "remote_host_fingerprint_mismatch") return "hosts.workspace.trustHelp";
  if (code === "paired_device_limit") return "hosts.workspace.pairDeviceLimit";
  return "hosts.workspace.pairFailed";
}

/** 한 번에 한 컴퓨터만 연결한다. 확인 → 진행 중 → (실패 사유)의 표시 상태이고, 연결 결과의 진실은 workspace snapshot이다. */
type PairState =
  | { readonly hostKey: string; readonly phase: "confirm" }
  | { readonly hostKey: string; readonly phase: "busy" }
  | { readonly hostKey: string; readonly phase: "failed"; readonly key: HostWorkspaceMessageKey };

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
  const [pairing, setPairing] = useState<PairState | null>(null);
  const pairAbort = useRef<AbortController | null>(null);
  // 화면이 내려가면 진행 중인 연결도 끝낸다 — 남은 응답이 사라진 화면을 칠하지 않는다.
  useEffect(() => () => { pairAbort.current?.abort(); }, []);
  // 목록에서 사라진 컴퓨터의 연결은 끝낸다 — 옛 컴퓨터의 결과가 같은 자리의 다른 컴퓨터에 붙지 않는다.
  const pairingHostKey = pairing?.hostKey ?? null;
  const pairingHostListed = pairingHostKey === null || state.hosts.some((host) => host.hostKey === pairingHostKey);
  useEffect(() => {
    if (pairingHostListed) return;
    pairAbort.current?.abort();
    pairAbort.current = null;
    setPairing(null);
  }, [pairingHostListed]);
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

  /**
   * 명시 클릭으로만 연결한다(펼침은 연결하지 않는다). 성공은 그 컴퓨터를 관찰 상태로 갱신할 뿐이고 선택·제어 획득·창 이동은 없다.
   * 다른 컴퓨터의 연결을 시작하면 앞선 진행은 취소한다.
   */
  const startPair = (hostKey: string) => {
    pairAbort.current?.abort();
    const controller = new AbortController();
    pairAbort.current = controller;
    // 시작한 컴퓨터의 수명. 그사이 gateway 수명이 바뀌면 그 결과는 지금 카드의 것이 아니다.
    const started = hosts.getSnapshot().hosts.find((host) => host.hostKey === hostKey);
    const current = () => {
      if (pairAbort.current !== controller || controller.signal.aborted) return false;
      const host = hosts.getSnapshot().hosts.find((candidate) => candidate.hostKey === hostKey);
      // 성공한 관찰은 epoch를 하나 올린다 — 수명 판정은 instance로 하고, epoch는 시작보다 뒤로 가지 않았는지만 본다.
      return host !== undefined && host.instanceId === started?.instanceId && host.epoch >= (started?.epoch ?? 0);
    };
    setPairing({ hostKey, phase: "busy" });
    void hosts.pair(hostKey, controller.signal).then(
      () => {
        if (pairAbort.current !== controller) return;
        pairAbort.current = null;
        setPairing(null);
      },
      (cause: unknown) => {
        if (!current()) {
          // 옛 수명·취소된 시도의 실패는 새 카드에 칠하지 않는다. 진행 표시만 내려 둔다.
          if (pairAbort.current === controller) { pairAbort.current = null; setPairing(null); }
          return;
        }
        pairAbort.current = null;
        setPairing({ hostKey, phase: "failed", key: pairFailureKey(cause instanceof Error ? cause.message : "") });
      },
    );
  };
  const cancelPair = () => {
    const controller = pairAbort.current;
    pairAbort.current = null;
    controller?.abort();
    setPairing(null);
  };

  return <div className="host-workspace-sidebar">
    <div className="host-workspace-computers" aria-label={t("hosts.workspace.selectConversation")}>
      {state.hosts.map((host, index) => {
        const local = host.hostKey === "local";
        const selected = host.hostKey === state.selection.hostKey;
        const open = expanded[host.hostKey] === true;
        const ready = host.phase === "ready";
        const blocked = host.connection === "blocked" || host.connection === "closed" || host.trust === "mismatch";
        // 이 기기가 아직 페어링되지 않은 컴퓨터만 화면 안 연결을 내놓는다. 다른 차단(끊김·인증서 변경)은 기존 안내 그대로다.
        const unpaired = !local && host.trust !== "mismatch" && host.error === "remote_host_not_paired";
        const hostPairing = pairing?.hostKey === host.hostKey ? pairing : null;
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
            {blocked && unpaired ? <div className="host-workspace-note host-workspace-pair">
              <p>{t("hosts.workspace.pairNeeded", { host: host.label })}</p>
              {hostPairing?.phase === "confirm" ? <>
                <p>{t("hosts.workspace.pairConfirm", { host: host.label })}</p>
                <div className="host-workspace-pair-actions">
                  <button type="button" className="host-workspace-back" onClick={() => startPair(host.hostKey)}>{t("hosts.workspace.pairConfirmAction")}</button>
                  <button type="button" className="host-workspace-back" onClick={cancelPair}>{t("hosts.workspace.pairCancel")}</button>
                </div>
              </> : hostPairing?.phase === "busy" ? <div className="host-workspace-pair-actions">
                <p role="status" aria-live="polite">{t("hosts.workspace.pairBusy", { host: host.label })}</p>
                <button type="button" className="host-workspace-back" onClick={cancelPair}>{t("hosts.workspace.pairCancel")}</button>
              </div> : <>
                {hostPairing?.phase === "failed" ? <p role="alert">{t(hostPairing.key, { host: host.label })}</p> : null}
                <button type="button" className="host-workspace-back" disabled={pairing?.phase === "busy"} onClick={() => setPairing({ hostKey: host.hostKey, phase: "confirm" })}>{t("hosts.workspace.pairAction")}</button>
              </>}
              <button type="button" className="host-workspace-back" onClick={hosts.returnLocal}>{t("hosts.workspace.returnLocal")}</button>
            </div> : blocked ? <div className="host-workspace-note"><p>{t(host.trust === "mismatch" ? "hosts.workspace.trustHelp" : "hosts.workspace.connectionHelp")}</p>
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
  // 실행 Operation이 없으면 확인된 미기동 목표의 제목을 쓴다. 두 목록을 합치지 않는다.
  const operation = state.selection.role === "commander"
    ? host.operations.find((item) => item.id === state.selection.operationId && item.theaterId === state.selection.theaterId)
      ?? host.objectives?.find((item) => item.id === state.selection.operationId && item.theaterId === state.selection.theaterId)
    : null;
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
