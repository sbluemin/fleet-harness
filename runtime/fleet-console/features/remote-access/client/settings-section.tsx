import "@fleet-console/font-picker/styles.css";
import type { Translate } from "@fleet-console/i18n";
import { SettingsGroup, SettingsRow, SettingsSubScreenRow, SettingsToggle } from "../../settings/client/preferences-context.js";
import { useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import { useEffect, useRef, useState, type RefObject } from "react";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { renderMessage, useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { AddHostDialog } from "../../remote-access/client/add-host-dialog.js";
import { REMOTE_AUTO_PORT_MAX, REMOTE_AUTO_PORT_MIN, buildRemoteEndpointPresentation, generateRemoteAutoPort, isCommittableRemotePortDraft, isValidRemoteAdvertisedHost, isValidRemoteListenAddress, isWarnableLocalPort, remoteAccessStateEquals, remoteEndpointImpact, type RemoteAccessInterface, type RemoteAccessLink, type RemoteAccessPort, type RemoteAccessState, type RemoteAccessStatus, type RemoteEndpointRequirement, type RemoteForwardRule } from "../../remote-access/client/contracts.js";
import { PairDeviceDialog } from "../../remote-access/client/pair-device-dialog.js";
import { forgetRemoteHost, probeRemoteHost, refreshRemoteHosts, renameRemoteHost, useRemoteHosts, type RemoteHost, type RemoteHostReach } from "../../remote-access/client/remote-hosts.js";
import { createRemoteAccessLink, fetchRemoteAccessStatus, revokeRemoteAccessDevice, revokeRemoteAccessLink, revokeRemoteAccessSession, rotateRemoteIdentity } from "../../settings/client/global-settings-api.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { pushMobileSheet } from "../../../core/client/src/chrome/mobile/mobile-store.js";

type T = Translate<CoreMessageKey>;
type RemoteSubTab = "share" | "connect";
type SetupStep = 1 | 2;
type RemotePortField = "listenPort" | "advertisedPort";
type PortDrafts = { readonly [field in RemotePortField]: string | null };
type RemoteConsequence = "restart" | "identity" | "stop";

const REMOTE_GRANT_TTL_MINUTES = 15;
const ROTATE_ARM_TIMEOUT_MS = 5_000;
/** README와 같은 최신 Desktop 아티팩트 진입점 — bare /releases가 아니라 latest로 바로 보낸다. */
const FLEET_DESKTOP_RELEASES_URL = "https://github.com/sbluemin/fleet-harness/releases/latest";
const EMPTY_PORT_DRAFTS: PortDrafts = { listenPort: null, advertisedPort: null };

export function RemoteAccessSection({ remote, saving }: { readonly remote: RemoteAccessState; readonly saving: boolean }) {
  // 폰은 SDK 설정 키트로 읽는다: 토글 행 + 「세부 설정」 하위 화면 행(요약 줄이 수신 상태, 화면은 아래 데스크톱 섹션 그대로).
  // 렌더만 갈린다 — 상태 읽기·저장·발급·해지는 두 배치가 같은 함수를 쓴다.
  if (useMobileSettingsHost()) return <MobileRemoteAccess remote={remote} saving={saving} />;
  return <DesktopRemoteAccess remote={remote} saving={saving} />;
}

/** 리스너 상태 — 저장된 설정이 바뀔 때와 `refresh` 때 다시 읽는다. 두 배치가 같은 읽기를 쓴다. */
function useRemoteAccessStatus(remote: RemoteAccessState): { readonly status: RemoteAccessStatus | null; readonly refresh: () => void } {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetchRemoteAccessStatus(controller.signal)
      .then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [remote.enabled, remote.publicEndpointEnabled, remote.listenAddress, remote.listenPort.value, remote.advertisedHost, remote.advertisedPort.value, reloadToken]);
  return { status, refresh: () => setReloadToken((token) => token + 1) };
}

function DesktopRemoteAccess({ remote, saving }: { readonly remote: RemoteAccessState; readonly saving: boolean }) {
  const t = useT();
  const hosts = useRemoteHosts();
  const { status, refresh } = useRemoteAccessStatus(remote);
  const [subTab, setSubTab] = useState<RemoteSubTab>("share");
  const [link, setLink] = useState<RemoteAccessLink | null>(null);
  const [monitoringOnly, setMonitoringOnly] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);
  // 방금 만든 링크를 QR로 넘기는 창. 발급된 링크 자체(link)와 분리해 둔다 — 창을 닫아도 링크는
  // 카드에 남아야 하고, 카드에 남은 링크는 다시 열 수 있어야 한다.
  const [pairing, setPairing] = useState<RemoteAccessLink | null>(null);
  const showQrRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!rotateArmed) return;
    const timer = setTimeout(() => setRotateArmed(false), ROTATE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rotateArmed]);

  const listening = status?.listener.listening === true;

  const save = async (next: RemoteAccessState, options?: { readonly openQrAfter?: boolean }): Promise<boolean> => {
    setLink(null);
    // 리스너가 바뀌면 그 링크가 가리키던 주소가 사라진다 — 살아 있는 QR을 그대로 두면 이미
    // 닿지 않는 자격을 계속 비추게 된다.
    setPairing(null);
    setActionError(null);
    setRotateArmed(false);
    if (options?.openQrAfter) setBusy("create");
    try {
      // 저장은 낙관적 상태를 먼저 쓴다. 그 값에 걸린 위 effect는 서버가 리스너를 다시 세우기 전에
      // 상태를 읽고, 뒤이어 도착하는 응답은 값이 같아 effect를 다시 깨우지 않는다 — 저장이 끝난 뒤
      // 한 번 더 읽지 않으면 신원과 링크는 새로 고침 전까지 예전 값에 머문다.
      const ok = await setGlobalSettingsField("remoteAccess", next);
      if (ok && options?.openQrAfter) {
        const latest = await fetchRemoteAccessStatus().catch(() => null);
        if (latest?.listener.listening) {
          const issued = await createRemoteAccessLink(monitoringOnly ? "monitoring" : "full");
          setLink(issued);
          setPairing(issued);
          setCopied(false);
        }
      }
      return ok;
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (options?.openQrAfter) setBusy(null);
      refresh();
    }
  };

  const run = (kind: "create" | "rotate" | "revoke", action: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    void action()
      // 새 링크는 곧바로 QR 창으로 넘긴다. 발급과 전달이 갈라져 있으면 남은 일이 전부 제품
      // 밖에서 일어나고, 그 바깥 경로가 바로 이 화면이 보내지 말라고 경고하는 경로다.
      .then((result) => { if (kind === "create") { const issued = result as RemoteAccessLink; setLink(issued); setPairing(issued); setCopied(false); } })
      .catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { setBusy(null); refresh(); });
  };

  const handleRotate = () => {
    if (!rotateArmed) { setRotateArmed(true); return; }
    setRotateArmed(false);
    setLink(null);
    // 갱신은 발급된 링크를 전부 무효로 만든다. 열려 있던 QR을 남겨 두면 아무도 붙을 수
    // 없는 자격을 계속 비추는 창이 된다.
    setPairing(null);
    run("rotate", rotateRemoteIdentity);
  };

  return (
    <>
      <section className="global-settings-card remote-section" aria-label={t("settings.remote.title")}>
        <header className="remote-section-head">
          <p>{t("settings.remote.lede")}</p>
          <RemoteListenerLozenge status={status} listening={listening} ready={buildRemoteEndpointPresentation(remote).ready} />
        </header>

        {/* 이 Console 공유(인바운드)와 다른 Console 접속(아웃바운드)을 갈라 첫 화면의 방향 혼동을 없앤다. */}
        <div className="remote-subtabs" role="tablist" aria-label={t("settings.remote.title")}>
          <button
            type="button"
            role="tab"
            className={`remote-subtab ${subTab === "share" ? "is-active" : ""}`}
            aria-selected={subTab === "share"}
            onClick={() => setSubTab("share")}
          >
            <span>{t("settings.remote.tab.share")}</span>
            {listening ? <span className="remote-subtab-dot" aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            role="tab"
            className={`remote-subtab ${subTab === "connect" ? "is-active" : ""}`}
            aria-selected={subTab === "connect"}
            onClick={() => setSubTab("connect")}
          >
            <span>{t("settings.remote.tab.connect")}</span>
            {hosts.length > 0 ? <span className="remote-subtab-count">{hosts.length}</span> : null}
          </button>
        </div>

        {subTab === "connect" ? (
          <RemoteHostsCard hosts={hosts} />
        ) : (
          <RemoteShareFlow
            remote={remote}
            saving={saving}
            status={status}
            link={link}
            copied={copied}
            monitoringOnly={monitoringOnly}
            busy={busy}
            rotateArmed={rotateArmed}
            showQrRef={showQrRef}
            onSave={save}
            onMonitoringOnly={setMonitoringOnly}
            onCreate={() => run("create", () => createRemoteAccessLink(monitoringOnly ? "monitoring" : "full"))}
            onCopy={() => {
              if (!link) return;
              void navigator.clipboard.writeText(link.link).then(() => setCopied(true)).catch(() => setCopied(false));
            }}
            onShowQr={() => setPairing(link)}
            onRevokeLink={(id) => run("revoke", () => revokeRemoteAccessLink(id))}
            onRevokeSession={(handle) => run("revoke", () => revokeRemoteAccessSession(handle))}
            onRevokeDevice={(id) => run("revoke", () => revokeRemoteAccessDevice(id))}
            onRotate={handleRotate}
          />
        )}

        {actionError ? <p className="global-settings-error" role="alert">{actionError}</p> : null}
      </section>

      {pairing ? (
        <PairDeviceDialog
          link={pairing}
          openerRef={showQrRef}
          onClose={() => {
            setPairing(null);
            // 창이 본 것은 창 안에만 남는다 — 닫으면서 다시 읽지 않으면 방금 붙은 기기가 없고
            // 이미 쓰인 링크가 그대로 있는 표로 돌아간다.
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 폰의 원격 접속(설정 목록의 「원격 접속」 상세 맨 위 토글 행). 토글은 데스크톱 카드의 「시작」·「중지」와 같은 저장이고,
 * 수신 중일 때 끄기는 데스크톱과 같은 「수신을 중지할까요?」 확인을 거친다. 켜기는 주소가 준비됐을 때만 된다.
 * 리스너·신원·링크·기기 해지는 「세부 설정 ›」가 연 전체 높이 시트에 데스크톱 카드 그대로 선다.
 * (원격 세션에는 서버가 이 설정을 보내지 않고 쓰기도 거절한다 — 이 화면은 이 컴퓨터에서만 선다.)
 */
function MobileRemoteAccess({ remote, saving }: { readonly remote: RemoteAccessState; readonly saving: boolean }) {
  const t = useT();
  const { status } = useRemoteAccessStatus(remote);
  const listening = status?.listener.listening === true;
  const ready = buildRemoteEndpointPresentation(remote).ready;
  const save = (next: RemoteAccessState) => void setGlobalSettingsField("remoteAccess", next);
  const state: CoreMessageKey = status === null ? "settings.remote.status.checking"
    : listening ? "settings.remote.status.listening"
      : status.listener.lastError ? "settings.remote.status.failed"
        : ready ? "settings.remote.status.stopped" : "settings.remote.status.setupRequired";
  const toggle = (next: boolean) => {
    if (next) { if (ready) save({ ...remote, enabled: true }); return; }
    if (!listening) { save({ ...remote, enabled: false }); return; }
    pushMobileSheet({
      kind: "confirm",
      spec: { question: t("settings.remote.stop.question"), cancelLabel: t("settings.remote.cancel"), confirmLabel: t("settings.remote.action.stop"), danger: true },
      resolve: (confirmed) => { if (confirmed) save({ ...remote, enabled: false }); },
    });
  };
  const blocked = !remote.enabled && !ready;
  const detail = listening ? status?.listener.origin : status?.listener.lastError;
  return (
    <SettingsGroup ariaLabel={t("settings.remote.title")}>
      <SettingsRow label={t("settings.remote.title")} hint={t("settings.remote.lede")} disabled={blocked}>
        <SettingsToggle checked={remote.enabled} busy={saving} disabled={blocked} ariaLabel={t("settings.remote.title")} onChange={toggle} />
      </SettingsRow>
      {/* 수신 상태는 세부 설정 행의 요약 줄이다 — 열지 않고도 지금 상태(와 수신 주소·실패 사유)를 읽는다. */}
      <SettingsSubScreenRow label={t("settings.remote.mobile.details")} summary={detail ? `${t(state)} · ${detail}` : t(state)} render={() => <RemoteDetailScreen />} />
    </SettingsGroup>
  );
}

/** 세부 설정 하위 화면 — 데스크톱 카드 그대로. 스토어를 읽으므로 저장이 곧바로 보인다. */
function RemoteDetailScreen() {
  const store = useGlobalSettingsStore();
  const remote = store.state?.remoteAccess;
  return remote === undefined ? null : <DesktopRemoteAccess remote={remote} saving={store.savingFields.has("remoteAccess")} />;
}

/**
 * 다른 콘솔로 건너가는 목록.
 * 더하는 일은 이 카드가 하지 않는다 — 액세스 링크 입력은 스위처와 공유하는 팝업 하나가
 * 소유한다(AddHostDialog). 이 카드는 이미 등록된 콘솔을 보고 고치고 지우는 자리다.
 */
function RemoteHostsCard({ hosts }: { readonly hosts: readonly RemoteHost[] }) {
  const t = useT();
  const [addOpen, setAddOpen] = useState(false);
  const [reach, setReach] = useState<Readonly<Record<string, RemoteHostReach | "checking">>>({});
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    for (const host of hosts) {
      void probeRemoteHost(host.id, controller.signal)
        .then((result) => setReach((previous) => ({ ...previous, [host.id]: result })))
        // 프로브가 거부되면 이 호스트의 도달 여부는 확인되지 않은 것이다. 자리를 비워 두면
        // 아래 행이 그것을 "응답함"으로 읽어 열기 버튼을 열어 준다 — 닿지 않는 주소로 보내는 길이다.
        .catch(() => {
          if (controller.signal.aborted) return;
          setReach((previous) => ({ ...previous, [host.id]: { reachable: false, trusted: false } }));
        });
    }
    return () => controller.abort();
  }, [hosts]);

  return (
    <div className="remote-group" data-remote-card="hosts">
      <div className="remote-card-head">
        <p className="remote-card-title">
          {t("settings.remote.hosts.title")}
          <SettingsHelp title={t("settings.remote.hosts.title")}>
            {t("settings.remote.hosts.help")}
          </SettingsHelp>
        </p>
        <button ref={addRef} type="button" className="remote-create is-primary" onClick={() => setAddOpen(true)}>
          {t("chrome.hosts.add")}
        </button>
      </div>

      <div className="remote-card">
        {hosts.length === 0 ? (
          <p className="remote-hosts-empty">{t("settings.remote.hosts.empty")}</p>
        ) : (
          <ul className="remote-hosts">
            {hosts.map((host) => (
              <RemoteHostRow key={host.id} host={host} reach={reach[host.id]} />
            ))}
          </ul>
        )}
      </div>

      <p className="remote-card-help">{t("settings.remote.hosts.pinned")}</p>
      {addOpen ? <AddHostDialog openerRef={addRef} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function RemoteHostRow({ host, reach }: { readonly host: RemoteHost; readonly reach: RemoteHostReach | "checking" | undefined }) {
  const t = useT();
  const [label, setLabel] = useState(host.label);
  const [busy, setBusy] = useState(false);
  const live = reach !== undefined && reach !== "checking" && reach.trusted;
  const answered = reach === undefined || reach === "checking" || reach.reachable;
  // 여는 것만 셸이 필요하다 — 추가·이름 변경·삭제는 서버가 하는 일이라 브라우저에서도 그대로다.
  const canOpen = isDesktopShell();

  return (
    <li className="remote-host">
      <span className={`remote-host-dot ${live ? "is-live" : ""}`} aria-hidden="true" />
      <span className="remote-host-text">
        <input
          className="remote-host-name"
          value={label}
          aria-label={t("settings.remote.hosts.rename")}
          maxLength={48}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => {
            const next = label.trim();
            if (next === host.label || next.length === 0) { setLabel(host.label); return; }
            setBusy(true);
            void renameRemoteHost(host.id, next).catch(() => setLabel(host.label)).finally(() => setBusy(false));
          }}
        />
        <small>{`${host.hostname}:${host.port} · ${canOpen ? reachLabel(reach, t) : t("settings.remote.hosts.desktopOnly")}`}</small>
      </span>
      <button
        type="button"
        className="remote-host-open"
        title={canOpen ? undefined : t("settings.remote.hosts.desktopOnly")}
        disabled={busy || !answered || !canOpen}
        onClick={() => location.assign(new URL("/console/", `${host.origin}/`).toString())}
      >
        {t("settings.remote.hosts.open")}
      </button>
      <button
        type="button"
        className="remote-revoke"
        disabled={busy}
        onClick={() => { setBusy(true); void forgetRemoteHost(host.id).finally(() => setBusy(false)); }}
      >
        {t("settings.remote.hosts.forget")}
      </button>
    </li>
  );
}

function reachLabel(reach: RemoteHostReach | "checking" | undefined, t: T): string {
  if (reach === undefined || reach === "checking") return t("settings.remote.hosts.checking");
  if (!reach.reachable) return t("settings.remote.hosts.unreachable");
  return reach.trusted ? t("settings.remote.hosts.reachable") : t("settings.remote.hosts.untrusted");
}

/**
 * 이 Console에 다른 기기의 접속을 허용하는 주 흐름.
 *
 * - 아직 수신 중이 아니거나(또는 경로 변경을 눌렀을 때): 1) 연결 방식 고르기 → 2) 안전 확인 후 켜기 → 3) QR 스캔의 3단계 인라인 가이드.
 * - 수신 중일 때: 상단 상태 요약 + 「QR로 기기 연결」 1차 동작 + 연결된 기기 목록 중심의 대시보드.
 * - 포트·수신 IP 직접 입력·인증서 신원은 하단 고급 드로어에 접어 두어 초심자 인지 부하를 덜고 기존 제어권은 모두 유지한다.
 */
function RemoteShareFlow({
  remote,
  saving,
  status,
  link,
  copied,
  monitoringOnly,
  busy,
  rotateArmed,
  showQrRef,
  onSave,
  onMonitoringOnly,
  onCreate,
  onCopy,
  onShowQr,
  onRevokeLink,
  onRevokeSession,
  onRevokeDevice,
  onRotate,
}: {
  readonly remote: RemoteAccessState;
  readonly saving: boolean;
  readonly status: RemoteAccessStatus | null;
  readonly link: RemoteAccessLink | null;
  readonly copied: boolean;
  readonly monitoringOnly: boolean;
  readonly busy: "create" | "rotate" | "revoke" | null;
  readonly rotateArmed: boolean;
  readonly showQrRef: RefObject<HTMLButtonElement | null>;
  readonly onSave: (next: RemoteAccessState, options?: { readonly openQrAfter?: boolean }) => Promise<boolean>;
  readonly onMonitoringOnly: (next: boolean) => void;
  readonly onCreate: () => void;
  readonly onCopy: () => void;
  readonly onShowQr: () => void;
  readonly onRevokeLink: (id: string) => void;
  readonly onRevokeSession: (handle: string) => void;
  readonly onRevokeDevice: (id: string) => void;
  readonly onRotate: () => void;
}) {
  const t = useT();
  const candidates = status?.interfaces ?? [];
  const listening = status?.listener.listening === true;

  // 저장된 값이 기준선이고 draft는 아직 보내지 않은 편집이다. 어떤 필드도 스스로 저장하지 않는다 —
  // 저장은 명시 액션뿐이며, 그래야 살아 있는 리스너가 편집 한 번에 조용히 꺼지지 않는다.
  const [draft, setDraft] = useState<RemoteAccessState>(remote);
  const [portDrafts, setPortDrafts] = useState<PortDrafts>(EMPTY_PORT_DRAFTS);
  // 예고는 열릴 때 계산된 것이므로 그때의 payload를 함께 얼린다. 뒤이은 편집이 확정에 얹혀 가면
  // "페어링은 남습니다"라고 적힌 확인이 페어링을 지우는 저장을 실어 나른다.
  const [shelf, setShelf] = useState<{ readonly kind: RemoteConsequence; readonly payload: RemoteAccessState } | null>(null);
  const [stale, setStale] = useState(false);
  const [step, setStep] = useState<SetupStep>(1);
  const [editingRoute, setEditingRoute] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(remote);
  const userTouchedAddressRef = useRef(false);

  useEffect(() => {
    const previous = baselineRef.current;
    if (remoteAccessStateEquals(previous, remote)) return;
    baselineRef.current = remote;
    if (remoteAccessStateEquals(draftRef.current, remote)) { setStale(false); return; }
    if (remoteAccessStateEquals(draftRef.current, previous)) {
      setDraft(remote);
      setStale(false);
      return;
    }
    // 편집 중에 저장된 값이 바뀌었다. 사용자의 입력을 덮지 않고 멈춰 세운다 —
    // 낡은 기준선으로 영향을 판정하면 신원 교체를 단순 재시작으로 잘못 알린다.
    setStale(true);
  }, [remote]);

  // 처음 켜려는 상태에서 서버가 감지한 인터페이스가 있고 사용자가 아직 직접 지우지 않았다면
  // 1순위 추천 주소(Tailscale 우선, 없으면 로컬 망)를 draft에 미리 채워 1클릭으로 다음 단계에 갈 수 있게 한다.
  useEffect(() => {
    if (remote.enabled || remote.listenAddress !== "" || remote.publicEndpointEnabled) return;
    if (userTouchedAddressRef.current || draftRef.current.listenAddress !== "" || draftRef.current.publicEndpointEnabled) return;
    const preferred = candidates[0];
    if (!preferred) return;
    setDraft((current) => (current.listenAddress === "" && !current.publicEndpointEnabled
      ? { ...current, listenAddress: preferred.address }
      : current));
  }, [candidates, remote.enabled, remote.listenAddress, remote.publicEndpointEnabled]);

  // 공표한 포트를 다른 프로그램이 쥐고 있으면 신원 갱신이 유일한 해제 길이다 — 고급 드로어를 스스로 열어 바로 보이게 한다.
  useEffect(() => {
    if (status?.listener.lastError === "remote_port_unavailable") setAdvancedOpen(true);
  }, [status?.listener.lastError]);

  const presentation = buildRemoteEndpointPresentation(draft);
  const dirty = !remoteAccessStateEquals(draft, remote);
  // 화면에 떠 있는 칸의 거부된 입력만 액션을 막는다. 보이지 않는 칸의 잔여 입력이 막으면
  // 사용자는 원인을 볼 수 없는 채로 적용을 잃는다.
  const portError = (draft.listenPort.mode === "custom" && portDrafts.listenPort !== null)
    || (draft.publicEndpointEnabled && draft.advertisedPort.mode === "custom" && portDrafts.advertisedPort !== null);
  const blocked = saving || busy !== null || stale || portError;
  const configured = remote.enabled && Boolean(remote.publicEndpointEnabled ? remote.advertisedHost : remote.listenAddress);

  // 어떤 편집이든 열려 있던 예고를 닫는다. 화면이 바뀌었으면 그 예고는 더 이상 이 화면의 이야기가 아니다.
  const edit = (patch: Partial<RemoteAccessState>) => {
    setShelf(null);
    setDraft((current) => ({ ...current, ...patch, acknowledgment: null }));
  };
  const editPortRaw = (field: RemotePortField, raw: string) => {
    const committable = isCommittableRemotePortDraft(raw);
    // 잘못된 입력은 지우지 않고 남긴다. 값이 사라지면 무엇이 거부됐는지 볼 수 없다.
    setShelf(null);
    setPortDrafts((current) => ({ ...current, [field]: committable ? null : raw }));
    if (committable) edit({ [field]: { mode: "custom", value: Number(raw) } });
  };
  // 모드 전환과 재추첨은 그 칸의 값을 통째로 갈아치우므로 거부된 입력도 함께 버린다 —
  // 남겨 두면 Auto로 돌아간 뒤 화면에 없는 오류가 액션을 계속 막는다.
  const editPortField = (field: RemotePortField, port: RemoteAccessState["listenPort"]) => {
    setPortDrafts((current) => ({ ...current, [field]: null }));
    edit({ [field]: normalizeAutoPort(port) });
  };
  const acknowledge = (checked: boolean) => {
    setShelf(null);
    setDraft((current) => ({
      ...current,
      acknowledgment: checked ? {
        version: 1 as const,
        listenAddress: current.listenAddress,
        listenPort: current.listenPort.value,
        advertisedHost: current.advertisedHost,
        advertisedPort: current.advertisedPort.value,
      } : null,
    }));
  };

  const persist = (next: RemoteAccessState, options?: { readonly openQrAfter?: boolean }) => {
    setDraft(next);
    setPortDrafts(EMPTY_PORT_DRAFTS);
    setShelf(null);
    setStale(false);
    setEditingRoute(false);
    void onSave(next, options);
  };
  const discard = () => {
    userTouchedAddressRef.current = false;
    setDraft(remote);
    setPortDrafts(EMPTY_PORT_DRAFTS);
    setShelf(null);
    setStale(false);
    setEditingRoute(false);
  };
  const requestApply = () => {
    const payload = { ...draft, enabled: true };
    if (!listening) { persist(payload); return; }
    const impact = remoteEndpointImpact(remote, draft);
    if (impact === "none") { persist(payload); return; }
    setShelf({ kind: impact, payload });
  };

  const selectInterface = (entry: RemoteAccessInterface) => {
    userTouchedAddressRef.current = true;
    edit({ publicEndpointEnabled: false, listenAddress: entry.address });
  };

  const selectPublicMode = () => {
    userTouchedAddressRef.current = true;
    // NAT 포워딩은 보통 로컬 LAN 주소로 전달하므로, 로컬 인터페이스가 감지돼 있고 주소가 비었거나 Tailscale이면 로컬 주소를 기본으로 제안한다.
    const localCandidate = candidates.find((entry) => entry.kind === "local") ?? candidates[0];
    const nextListen = draft.listenAddress && isValidRemoteListenAddress(draft.listenAddress)
      ? draft.listenAddress
      : (localCandidate?.address ?? "");
    edit({ publicEndpointEnabled: true, listenAddress: nextListen });
  };

  const step1Summary = describeSelectedRoute(draft, candidates, t);
  const showDashboard = listening && !editingRoute;

  return (
    <div className="remote-share-flow">
      {showDashboard ? (
        <>
          <div className="remote-group" data-remote-card="listener">
            <div className="remote-card remote-live-card">
              <div className="remote-live-head">
                <div className="remote-live-info">
                  <p className="remote-live-title">
                    <span className="remote-live-dot" aria-hidden="true" />
                    <span>{t("settings.remote.live.title")}</span>
                  </p>
                  <RemoteRoutePreview presentation={buildRemoteEndpointPresentation(remote)} live t={t} />
                </div>
                <div className="remote-live-actions">
                  <button
                    ref={showQrRef}
                    type="button"
                    className="remote-create is-primary"
                    disabled={busy !== null || saving}
                    onClick={onCreate}
                  >
                    {busy === "create" ? t("settings.remote.creating") : t("settings.remote.live.pairQr")}
                  </button>
                  <button
                    type="button"
                    className="remote-create is-quiet"
                    disabled={saving}
                    onClick={() => { setDraft(remote); setShelf(null); setStep(1); setEditingRoute(true); }}
                  >
                    {t("settings.remote.live.changeRoute")}
                  </button>
                  <button
                    type="button"
                    className="remote-create is-danger"
                    disabled={saving}
                    onClick={() => setShelf({ kind: "stop", payload: { ...remote, enabled: false } })}
                  >
                    {t("settings.remote.live.turnOff")}
                  </button>
                </div>
              </div>

              {link ? (
                <div className="remote-live-link">
                  <div className="remote-link-field">
                    <input readOnly value={link.link} aria-label={t("settings.remote.linkLabel")} onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" onClick={onShowQr}>{t("settings.remote.pair.open")}</button>
                    <button type="button" onClick={onCopy}>{copied ? t("settings.remote.copied") : t("settings.remote.copy")}</button>
                  </div>
                  {/*
                    링크는 인코딩된 봉투일 뿐 암호가 아니다 — 받은 쪽은 물론 그 문자열이 지나간 곳도 풀어
                    볼 수 있다. monitoring 링크는 명령을 실행하지 못하므로 full일 때만 그 문장을 붙인다.
                  */}
                  {link.access === "full" ? <p className="remote-card-help">{t("settings.remote.warning")}</p> : null}
                </div>
              ) : null}

              <div className="remote-live-option-row">
                <label className="remote-monitoring">
                  <input type="checkbox" checked={monitoringOnly} disabled={busy !== null} onChange={(event) => onMonitoringOnly(event.target.checked)} />
                  <span>{t("settings.remote.monitoringOnly")}</span>
                </label>
                <SettingsHelp title={t("settings.remote.links.title")}>
                  {renderMessage(t("settings.remote.links.rule"), { minutes: REMOTE_GRANT_TTL_MINUTES })}
                </SettingsHelp>
              </div>

              {/* 거절이 일어나고 있다는 사실은 "지금 열어둘 만한가"의 판단 재료다. 조용히 세고만 있으면 값이 없다. */}
              {status !== null && status.rejectedJoins.count > 0 ? (
                <p className="remote-status-note">
                  {renderMessage(t("settings.remote.rejectedJoins"), { count: String(status.rejectedJoins.count) })}
                </p>
              ) : null}

              {shelf?.kind === "stop" ? (
                <RemoteConsequenceShelf
                  kind="stop"
                  t={t}
                  busy={saving}
                  onConfirm={() => persist(shelf.payload)}
                  onCancel={() => setShelf(null)}
                />
              ) : null}
            </div>
          </div>

          {status ? (
            <RemoteDevicesCard
              status={status}
              busy={busy}
              onRevokeLink={onRevokeLink}
              onRevokeSession={onRevokeSession}
              onRevokeDevice={onRevokeDevice}
            />
          ) : null}
        </>
      ) : (
        <div className="remote-stepper" data-remote-card="listener">
          {editingRoute ? (
            <div className="remote-editing-banner">
              <span>{t("settings.remote.live.editingNotice")}</span>
              <button type="button" className="remote-create is-quiet" disabled={saving} onClick={discard}>
                {t("settings.remote.live.backToLive")}
              </button>
            </div>
          ) : null}

          {status?.listener.lastError ? (
            <p className="remote-card-alert remote-step-alert" role="alert">{t(remoteErrorKey(status.listener.lastError))}</p>
          ) : null}

          {/* 1단계: 어디서 접속할까요? */}
          <div className={`remote-card remote-step ${step === 1 ? "is-active" : "is-complete"}`}>
            <button
              type="button"
              className="remote-step-head"
              aria-expanded={step === 1}
              onClick={() => setStep(1)}
            >
              <span className={`remote-step-index ${step > 1 ? "is-done" : "is-active"}`} aria-hidden="true">
                {step > 1 ? "✓" : "1"}
              </span>
              <span className="remote-step-titles">
                <span className="remote-step-title">{t("settings.remote.step1.title")}</span>
                {step !== 1 ? <span className="remote-step-summary">{step1Summary}</span> : null}
              </span>
              {step !== 1 ? <span className="remote-step-change">{t("settings.remote.step1.change")}</span> : null}
            </button>

            {step === 1 ? (
              <div className="remote-step-body">
                <p className="remote-field-legend" id="remote-listen-presets-label">{t("settings.remote.listenPresets")}</p>
                <div className="remote-interface-presets remote-mode-choices" role="group" aria-labelledby="remote-listen-presets-label">
                  {candidates.map((entry, index) => {
                    const selected = !draft.publicEndpointEnabled && draft.listenAddress === entry.address;
                    const isTailscale = entry.kind === "tailscale";
                    const hasTailscale = candidates.some((candidate) => candidate.kind === "tailscale");
                    const badge = isTailscale || (!hasTailscale && index === 0)
                      ? t("settings.remote.step1.badgeRecommended")
                      : t("settings.remote.step1.badgeSameNetwork");
                    return (
                      <button
                        key={entry.address}
                        type="button"
                        className={`remote-interface-preset ${selected ? "is-selected" : ""}`}
                        aria-pressed={selected}
                        disabled={saving}
                        onClick={() => selectInterface(entry)}
                      >
                        <div className="remote-choice-top">
                          <span className="remote-choice-name">
                            {isTailscale ? t("settings.remote.step1.tailscaleTitle") : t("settings.remote.step1.localTitle")}
                          </span>
                          <span className={`remote-choice-badge ${isTailscale || (!hasTailscale && index === 0) ? "is-recommended" : ""}`}>
                            {badge}
                          </span>
                        </div>
                        <span className="remote-choice-desc">
                          {isTailscale ? t("settings.remote.step1.tailscaleDesc") : t("settings.remote.step1.localDesc")}
                        </span>
                        <code>{`${entry.label} · ${entry.address}`}</code>
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    className={`remote-interface-preset ${draft.publicEndpointEnabled ? "is-selected" : ""}`}
                    aria-pressed={draft.publicEndpointEnabled}
                    disabled={saving}
                    onClick={selectPublicMode}
                  >
                    <div className="remote-choice-top">
                      <span className="remote-choice-name">{t("settings.remote.step1.publicTitle")}</span>
                      <span className="remote-choice-badge">{t("settings.remote.step1.badgeAdvanced")}</span>
                    </div>
                    <span className="remote-choice-desc">{t("settings.remote.step1.publicDesc")}</span>
                  </button>
                </div>

                {candidates.length === 0 && !draft.publicEndpointEnabled ? (
                  <div className="remote-listen-address-control">
                    <p className="remote-card-help">{t("settings.remote.step1.noInterfaces")}</p>
                    <label className="remote-field">
                      <span>{t("settings.remote.listenAddress")}</span>
                      <input
                        value={draft.listenAddress}
                        disabled={saving}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t("settings.remote.listenPlaceholder")}
                        aria-invalid={draft.listenAddress !== "" && !isValidRemoteListenAddress(draft.listenAddress)}
                        onChange={(event) => {
                          userTouchedAddressRef.current = true;
                          edit({ listenAddress: event.target.value.trim() });
                        }}
                      />
                    </label>
                    <p className="remote-card-help">{t("settings.remote.listenHelp")}</p>
                  </div>
                ) : null}

                {draft.publicEndpointEnabled ? (
                  <div className="remote-public-panel">
                    {candidates.length === 0 || !isValidRemoteListenAddress(draft.listenAddress) ? (
                      <label className="remote-field">
                        <span>{t("settings.remote.listenAddress")}</span>
                        <input
                          value={draft.listenAddress}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={t("settings.remote.listenPlaceholder")}
                          aria-invalid={draft.listenAddress !== "" && !isValidRemoteListenAddress(draft.listenAddress)}
                          onChange={(event) => {
                            userTouchedAddressRef.current = true;
                            edit({ listenAddress: event.target.value.trim() });
                          }}
                        />
                      </label>
                    ) : null}

                    <div className="remote-endpoint-grid">
                      <label className="remote-field">
                        <span>{t("settings.remote.advertisedHost")}</span>
                        <input
                          value={draft.advertisedHost}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={t("settings.remote.advertisedPlaceholder")}
                          aria-invalid={draft.advertisedHost !== "" && !isValidRemoteAdvertisedHost(draft.advertisedHost)}
                          onChange={(event) => edit({ advertisedHost: event.target.value.trim().toLowerCase() })}
                        />
                      </label>
                      <RemotePortControl
                        label={t("settings.remote.advertisedPort")}
                        errorId="remote-advertised-port-error"
                        port={draft.advertisedPort}
                        raw={portDrafts.advertisedPort}
                        saving={saving}
                        onMode={(mode) => editPortField("advertisedPort", { ...draft.advertisedPort, mode })}
                        onRaw={(raw) => editPortRaw("advertisedPort", raw)}
                        onRegenerate={() => editPortField("advertisedPort", { mode: "auto", value: generateRemoteAutoPort() })}
                      />
                    </div>
                    <p className="remote-card-help">{t("settings.remote.advertisedAutoHelp")}</p>

                    {presentation.forward === null ? null : <RemoteForwardRuleCard rule={presentation.forward} t={t} />}

                    <label className="remote-acknowledgment">
                      <input
                        type="checkbox"
                        checked={draft.acknowledgment !== null}
                        disabled={saving || presentation.origin === null}
                        onChange={(event) => acknowledge(event.target.checked)}
                      />
                      <span>{t("settings.remote.acknowledgment")}</span>
                    </label>
                    <p className="remote-status-note">
                      <strong>{t("settings.remote.publicReachability")}</strong> {t("settings.remote.publicNotTested")}
                    </p>
                    <p className="remote-card-help">{t("settings.remote.publicTestHelp")}</p>
                  </div>
                ) : null}

                {presentation.missing.length > 0 ? (
                  <ul className="remote-requirements">
                    {presentation.missing.map((requirement) => (
                      <li key={requirement}>{t(REMOTE_REQUIREMENT_KEYS[requirement])}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="remote-step-foot">
                  <span className="remote-step-hint">
                    {renderMessage(
                      t(draft.listenPort.mode === "auto" ? "settings.remote.step1.portAutoHint" : "settings.remote.step1.portCustomHint"),
                      { port: String(draft.listenPort.value) },
                    )}
                  </span>
                  <button
                    type="button"
                    className="remote-create is-primary"
                    disabled={blocked || !presentation.ready}
                    onClick={() => setStep(2)}
                  >
                    {t("settings.remote.step1.next")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* 2단계: 안전 확인 후 원격 접속 켜기 */}
          <div className={`remote-card remote-step ${step === 2 ? "is-active" : "is-idle"}`}>
            <div className="remote-step-head">
              <span className={`remote-step-index ${step === 2 ? "is-active" : "is-idle"}`} aria-hidden="true">2</span>
              <span className="remote-step-titles">
                <span className="remote-step-title">{t("settings.remote.step2.title")}</span>
                {step < 2 ? <span className="remote-step-summary">{t("settings.remote.step2.idle")}</span> : null}
              </span>
            </div>

            {step === 2 ? (
              <div className="remote-step-body">
                <div className="remote-step-danger" role="note">
                  <WarningIcon />
                  <span>
                    <strong>{t("settings.remote.danger.lead")}</strong> {t("settings.remote.danger.rest")}
                  </span>
                </div>

                <RemoteRoutePreview presentation={presentation} live={false} t={t} />

                <p className="remote-positive" role="note">
                  <PositiveIcon />
                  <span>
                    {renderMessage(t("settings.remote.desktop.note"), {
                      releases: (
                        <a href={FLEET_DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer">
                          {t("settings.remote.desktop.releases")}
                        </a>
                      ),
                    })}
                  </span>
                </p>

                {!editingRoute ? (
                  <label className="remote-monitoring">
                    <input type="checkbox" checked={monitoringOnly} disabled={busy !== null || saving} onChange={(event) => onMonitoringOnly(event.target.checked)} />
                    <span>{t("settings.remote.monitoringOnly")}</span>
                  </label>
                ) : null}

                {stale ? (
                  <div className="remote-stale" role="alert">
                    <span>{t("settings.remote.draft.stale")}</span>
                    <button type="button" className="remote-create is-quiet" onClick={discard}>{t("settings.remote.draft.reload")}</button>
                  </div>
                ) : null}

                {shelf ? (
                  <RemoteConsequenceShelf
                    kind={shelf.kind}
                    t={t}
                    busy={saving}
                    onConfirm={() => persist(shelf.payload)}
                    onCancel={() => setShelf(null)}
                  />
                ) : null}

                <div className="remote-step-foot">
                  <button type="button" className="remote-create is-quiet" disabled={saving || busy !== null} onClick={() => setStep(1)}>
                    {t("settings.remote.step2.back")}
                  </button>
                  <div className="remote-actions-buttons">
                    {editingRoute ? (
                      <>
                        {dirty ? (
                          <button type="button" className="remote-create is-quiet" disabled={saving} onClick={discard}>
                            {t("settings.remote.action.discard")}
                          </button>
                        ) : null}
                        <button type="button" className="remote-create is-primary" disabled={blocked || !presentation.ready || !dirty} onClick={requestApply}>
                          {t("settings.remote.action.apply")}
                        </button>
                      </>
                    ) : (
                      <>
                        {remote.enabled && !listening ? (
                          <button type="button" className="remote-create is-danger" disabled={saving} onClick={() => persist({ ...draft, enabled: false })}>
                            {t("settings.remote.action.stop")}
                          </button>
                        ) : (
                          <button type="button" className="remote-create is-quiet" disabled={blocked || !presentation.ready} onClick={() => persist({ ...draft, enabled: true })}>
                            {t("settings.remote.step2.startOnly")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="remote-create is-primary"
                          disabled={blocked || !presentation.ready}
                          onClick={() => persist({ ...draft, enabled: true }, { openQrAfter: true })}
                        >
                          {busy === "create" ? t("settings.remote.creating") : t("settings.remote.step2.startAndQr")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* 3단계: QR 스캔 예고 (경로 수정 중에는 이미 대시보드에서 QR을 열 수 있으므로 생략) */}
          {!editingRoute ? (
            <div className="remote-card remote-step is-idle">
              <div className="remote-step-head">
                <span className="remote-step-index is-idle" aria-hidden="true">3</span>
                <span className="remote-step-titles">
                  <span className="remote-step-title">{t("settings.remote.step3.title")}</span>
                  <span className="remote-step-summary">{t("settings.remote.step3.idle")}</span>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* 고급 네트워크 · 포트 · 인증서 신원 (기본 접힘 — 필요할 때만 펼친다) */}
      <div className="remote-advanced" data-remote-card="identity">
        <button
          type="button"
          className="remote-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>{t("settings.remote.advanced.title")}</span>
          <span className="remote-advanced-chevron" aria-hidden="true">{advancedOpen ? "▴" : "▾"}</span>
        </button>

        {advancedOpen ? (
          <div className="remote-advanced-body">
            <div className="remote-endpoint-grid">
              <div className="remote-listen-address-control">
                <label className="remote-field">
                  <span>{t("settings.remote.listenAddress")}</span>
                  <input
                    value={draft.listenAddress}
                    disabled={saving}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("settings.remote.listenPlaceholder")}
                    aria-invalid={draft.listenAddress !== "" && !isValidRemoteListenAddress(draft.listenAddress)}
                    onChange={(event) => {
                      userTouchedAddressRef.current = true;
                      edit({ listenAddress: event.target.value.trim() });
                    }}
                  />
                </label>
                <p className="remote-card-help">{t("settings.remote.listenHelp")}</p>
              </div>
              <RemotePortControl
                label={t("settings.remote.listenPort")}
                errorId="remote-listen-port-error"
                port={draft.listenPort}
                raw={portDrafts.listenPort}
                saving={saving}
                onMode={(mode) => editPortField("listenPort", { ...draft.listenPort, mode })}
                onRaw={(raw) => editPortRaw("listenPort", raw)}
                onRegenerate={() => editPortField("listenPort", { mode: "auto", value: generateRemoteAutoPort() })}
              />
            </div>

            {isWarnableLocalPort(draft.listenPort) ? <p className="remote-card-alert">{t("settings.remote.listenPrivileged")}</p> : null}

            {/* 대시보드에서 고급 항목만 바꾼 경우에도 바로 적용/되돌리기가 가능해야 한다. */}
            {showDashboard && dirty ? (
              <>
                {shelf && shelf.kind !== "stop" ? (
                  <RemoteConsequenceShelf
                    kind={shelf.kind}
                    t={t}
                    busy={saving}
                    onConfirm={() => persist(shelf.payload)}
                    onCancel={() => setShelf(null)}
                  />
                ) : null}
                <div className="remote-actions">
                  <span className="remote-actions-note">{t("settings.remote.draft.pending")}</span>
                  <div className="remote-actions-buttons">
                    <button type="button" className="remote-create is-quiet" disabled={saving} onClick={discard}>
                      {t("settings.remote.action.discard")}
                    </button>
                    <button type="button" className="remote-create is-primary" disabled={blocked || !presentation.ready} onClick={requestApply}>
                      {t("settings.remote.action.apply")}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <div className="remote-identity-block">
              <div className="remote-identity-info">
                <p className="remote-card-title">
                  {t("settings.remote.identity.title")}
                  <SettingsHelp title={t("settings.remote.identity.title")}>{t("settings.remote.identity.help")}</SettingsHelp>
                </p>
                {/* 지문이 없을 때의 문장은 값이 아니라 안내다 — 지문 서체(모노·청록)를 빌리지 않는다. */}
                {status?.fingerprint
                  ? <code className="remote-fingerprint">{status.fingerprint}</code>
                  : <p className="remote-fingerprint-empty">{t("settings.remote.identity.none")}</p>}
              </div>
              <button
                type="button"
                className={`remote-rotate ${rotateArmed ? "is-armed" : ""}`}
                /*
                  지문이 없다고 잠그지 않는다. 리스너가 열리지 못하면 지문도 없는데, 갱신이 가장
                  필요한 자리가 바로 그때다 — 공표한 포트를 남이 쥐고 있을 때 그것을 놓는 길이다.
                */
                disabled={busy !== null || !(status?.fingerprint || configured)}
                onClick={onRotate}
              >
                {busy === "rotate" ? t("settings.remote.rotate.busy") : rotateArmed ? t("settings.remote.rotate.arm") : t("settings.remote.rotate")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function describeSelectedRoute(draft: RemoteAccessState, candidates: readonly RemoteAccessInterface[], t: T): string {
  if (draft.publicEndpointEnabled) {
    return draft.advertisedHost
      ? `${t("settings.remote.step1.publicTitle")} · ${draft.advertisedHost}:${draft.advertisedPort.value}`
      : t("settings.remote.step1.publicTitle");
  }
  const matched = candidates.find((entry) => entry.address === draft.listenAddress);
  if (matched) {
    const label = matched.kind === "tailscale" ? t("settings.remote.step1.tailscaleTitle") : t("settings.remote.step1.localTitle");
    return `${label} · ${matched.address}`;
  }
  return draft.listenAddress || t("settings.remote.status.setupRequired");
}

/**
 * Auto는 Custom이 허용하는 1–65535 전체가 아니라 49152–65535만 쓴다. 사용자가 443 같은 값을
 * Custom으로 넣은 뒤 Auto로 돌리면 그 값이 그대로 남는데, 화면은 준비됨으로 보이고 저장은 서버에서
 * 거부된다 — 켜지지 않는 이유가 화면 밖에 있는 상태다. 전환하는 그 자리에서 유효한 값을 뽑아 둔다.
 */
function normalizeAutoPort(port: RemoteAccessPort): RemoteAccessPort {
  if (port.mode !== "auto") return port;
  if (port.value >= REMOTE_AUTO_PORT_MIN && port.value <= REMOTE_AUTO_PORT_MAX) return port;
  return { mode: "auto", value: generateRemoteAutoPort() };
}

const REMOTE_REQUIREMENT_KEYS: Record<RemoteEndpointRequirement, CoreMessageKey> = {
  listenAddress: "settings.remote.requirement.listenAddress",
  advertisedHost: "settings.remote.requirement.advertisedHost",
  acknowledgment: "settings.remote.requirement.acknowledgment",
};

/** 설정이 갖춰졌는지와 리스너가 살아 있는지는 다른 사실이다. 하나의 스위치로 합치면 둘 다 거짓말이 된다. */
function RemoteListenerLozenge({ status, listening, ready }: {
  readonly status: RemoteAccessStatus | null;
  readonly listening: boolean;
  readonly ready: boolean;
}) {
  const t = useT();
  const state = status === null ? "checking"
    : listening ? "listening"
      : status.listener.lastError ? "failed"
        : ready ? "stopped" : "setup";
  const label: CoreMessageKey = state === "checking" ? "settings.remote.status.checking"
    : state === "listening" ? "settings.remote.status.listening"
      : state === "failed" ? "settings.remote.status.failed"
        : state === "stopped" ? "settings.remote.status.stopped" : "settings.remote.status.setupRequired";
  return (
    // aria-label을 걸면 그 이름이 자식 텍스트를 덮어, 눈에 보이는 상태가 접근성 트리에서 사라진다.
    // 상태 문구 자체가 이름이 되게 두고, 바뀔 때 읽히도록 live 영역으로만 표시한다.
    <span className="remote-lozenge" data-remote-state={state} role="status">
      {t(label)}
    </span>
  );
}

function RemoteRoutePreview({ presentation, live, t }: {
  readonly presentation: ReturnType<typeof buildRemoteEndpointPresentation>;
  readonly live: boolean;
  readonly t: T;
}) {
  return (
    <div className="remote-route-preview">
      <p className="remote-route-caption">
        {t("settings.remote.route.title")}
        <span>{live ? t("settings.remote.route.current") : t("settings.remote.route.proposed")}</span>
      </p>
      {presentation.origin === null ? (
        <p className="remote-card-help">{t("settings.remote.route.waiting")}</p>
      ) : (
        <p className="remote-route-row"><span>{t("settings.remote.route.devicesUse")}</span><code>{presentation.origin}</code></p>
      )}
    </div>
  );
}

/**
 * 포워딩 규칙은 산문이 아니라 라우터 설정 화면의 칸 이름으로 준다. "위의 수신 주소와 포트로 전달"이라고만
 * 적으면 외부 포트를 내부 포트에도 그대로 넣는 실수가 나오고, 그러면 아무것도 듣지 않는 자리로 전달된다.
 */
function RemoteForwardRuleCard({ rule, t }: { readonly rule: RemoteForwardRule; readonly t: T }) {
  return (
    <div className="remote-forward-rule">
      <p className="remote-forward-rule-title">{t("settings.remote.forward.title")}</p>
      <dl>
        <div><dt>{t("settings.remote.forward.externalPort")}</dt><dd><code>{rule.externalPort}</code></dd></div>
        <div><dt>{t("settings.remote.forward.internalHost")}</dt><dd><code>{rule.internalHost}</code></dd></div>
        <div><dt>{t("settings.remote.forward.internalPort")}</dt><dd><code>{rule.internalPort}</code></dd></div>
      </dl>
      {rule.externalPort === rule.internalPort ? null : (
        <p className="remote-forward-rule-note">{t("settings.remote.forward.differs")}</p>
      )}
    </div>
  );
}

/** 적용이 무엇을 끊는지 먼저 말한다. 페어링이 살아남는 경우와 아닌 경우는 같은 문장으로 덮을 수 없다. */
function RemoteConsequenceShelf({ kind, t, busy, onConfirm, onCancel }: {
  readonly kind: RemoteConsequence;
  readonly t: T;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const copy = kind === "identity"
    ? { title: "settings.remote.impact.identityTitle", body: "settings.remote.impact.identityBody", confirm: "settings.remote.impact.identityConfirm" } as const
    : kind === "restart"
      ? { title: "settings.remote.impact.restartTitle", body: "settings.remote.impact.restartBody", confirm: "settings.remote.action.apply" } as const
      : { title: "settings.remote.stop.title", body: "settings.remote.stop.body", confirm: "settings.remote.action.stop" } as const;
  return (
    <div className={`remote-consequence is-${kind}`} role="group" aria-label={t(copy.title)}>
      <p className="remote-consequence-title">{t(copy.title)}</p>
      <p>{t(copy.body)}</p>
      <div className="remote-consequence-actions">
        <button type="button" className={`remote-create ${kind === "restart" ? "is-primary" : "is-danger"}`} disabled={busy} onClick={onConfirm}>{t(copy.confirm)}</button>
        <button type="button" className="remote-create is-quiet" disabled={busy} onClick={onCancel}>{t("settings.remote.cancel")}</button>
      </div>
    </div>
  );
}

function RemotePortControl({ label, errorId, port, raw, saving, onMode, onRaw, onRegenerate }: {
  readonly label: string;
  readonly errorId: string;
  readonly port: RemoteAccessPort;
  readonly raw: string | null;
  readonly saving: boolean;
  readonly onMode: (mode: "auto" | "custom") => void;
  readonly onRaw: (raw: string) => void;
  readonly onRegenerate: () => void;
}) {
  const t = useT();
  return <fieldset className="remote-port-control">
    <legend>{label}</legend>
    <div className="remote-port-modes">
      <label><input type="radio" checked={port.mode === "auto"} disabled={saving} onChange={() => onMode("auto")} />{t("settings.remote.portAuto")}</label>
      <label><input type="radio" checked={port.mode === "custom"} disabled={saving} onChange={() => onMode("custom")} />{t("settings.remote.portCustom")}</label>
    </div>
    <div className="remote-port-value">
      {port.mode === "auto" ? (
        <>
          {/* Auto는 이미 뽑아 둔 구체값을 지킨다. 다시 뽑는 것은 아래 버튼을 누른 때뿐이다. */}
          <span className="remote-port-auto">{renderMessage(t("settings.remote.portAutoValue"), { port: String(port.value) })}</span>
          <button type="button" className="remote-create is-quiet" disabled={saving} onClick={onRegenerate}>{t("settings.remote.portChooseAnother")}</button>
        </>
      ) : (
        <input type="number" min={1} max={65535} value={raw ?? String(port.value)} disabled={saving}
          aria-invalid={raw !== null} aria-label={label}
          aria-describedby={raw === null ? undefined : errorId}
          onChange={(event) => onRaw(event.target.value)} />
      )}
    </div>
    {/* 거부 사유는 거부한 칸에 붙는다 — 떨어뜨려 놓으면 보조 기술이 무엇이 잘못됐는지 닿을 길이 없다. */}
    {raw === null ? null : <p className="remote-port-error" id={errorId} role="alert">{t("settings.remote.portInvalid")}</p>}
  </fieldset>;
}

function RemoteDevicesCard({
  status,
  busy,
  onRevokeLink,
  onRevokeSession,
  onRevokeDevice,
}: {
  readonly status: RemoteAccessStatus;
  readonly busy: string | null;
  readonly onRevokeLink: (id: string) => void;
  readonly onRevokeSession: (handle: string) => void;
  readonly onRevokeDevice: (id: string) => void;
}) {
  const t = useT();
  /**
   * 두 종류의 줄이 한 표에 있다. 페어링된 기기는 회수해야 사라지고, 미사용 링크는 누가 쓰면
   * 스스로 사라진다. 그래서 기기 줄에는 버튼이 둘이다 — 지금 붙어 있는 접속을 끊는 것과,
   * 그 기기를 손님 목록에서 지우는 것은 되돌릴 수 있는 정도가 다르다.
   */
  const rows = [
    ...status.devices.map((entry) => ({
      key: entry.id,
      name: entry.device ?? t("settings.remote.table.unnamedDevice"),
      access: entry.access,
      when: entry.sessionHandle === null ? formatRelative(entry.lastSeenAt, t) : t("settings.remote.table.connected"),
      disconnect: entry.sessionHandle === null ? null : () => onRevokeSession(entry.sessionHandle!),
      revoke: () => onRevokeDevice(entry.id),
      revokeLabel: t("settings.remote.unpair"),
    })),
    ...status.links.map((entry) => ({
      key: entry.id,
      name: t("settings.remote.table.unusedLink"),
      access: entry.access,
      when: renderMessage(t("settings.remote.table.expiresIn"), { minutes: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 60_000)) }),
      disconnect: null,
      revoke: () => onRevokeLink(entry.id),
      revokeLabel: t("settings.remote.revoke"),
    })),
  ];

  return (
    <div className="remote-group" data-remote-card="links">
      <div className="remote-card-head">
        <p className="remote-card-title">
          {t("settings.remote.links.title")}
          <SettingsHelp title={t("settings.remote.links.title")}>
            {renderMessage(t("settings.remote.links.rule"), { minutes: REMOTE_GRANT_TTL_MINUTES })}
          </SettingsHelp>
        </p>
      </div>
      <div className="remote-card">
        <table className="remote-table">
          <thead>
            <tr>
              <th scope="col">{t("settings.remote.table.device")}</th>
              <th scope="col">{t("settings.remote.table.access")}</th>
              <th scope="col">{t("settings.remote.table.lastUsedHead")}</th>
              <th scope="col">{t("settings.remote.table.actionsHead")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={4} className="remote-table-empty">{t("settings.remote.table.empty")}</td></tr>
            ) : rows.map((row) => (
              <tr key={row.key}>
                <td data-label={t("settings.remote.table.device")}>{row.name}</td>
                <td data-label={t("settings.remote.table.access")}><span className={`remote-access-chip is-${row.access}`}>{row.access}</span></td>
                <td data-label={t("settings.remote.table.lastUsedHead")}>{row.when}</td>
                <td className="remote-row-actions" data-label={t("settings.remote.table.actionsHead")}>
                  {row.disconnect ? (
                    <button type="button" className="remote-disconnect" disabled={busy !== null} onClick={row.disconnect}>{t("settings.remote.disconnect")}</button>
                  ) : null}
                  <button type="button" className="remote-revoke" disabled={busy !== null} onClick={row.revoke}>{row.revokeLabel}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 같은 셀에 "접속 중"과 나란히 서므로 이 문장도 화면 언어를 따라야 한다. */
function formatRelative(epochMs: number, t: (key: CoreMessageKey) => string): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return t("settings.remote.table.justNow");
  if (minutes < 60) return t("settings.remote.table.minutesAgo").replace("{minutes}", String(minutes));
  const hours = Math.round(minutes / 60);
  return hours < 24 ? t("settings.remote.table.hoursAgo").replace("{hours}", String(hours)) : new Date(epochMs).toLocaleDateString();
}

function PositiveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.2 8.1 7.1 10l3.7-4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5 14.5 13.5H1.5L8 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.6v.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function remoteErrorKey(code: string): CoreMessageKey {
  switch (code) {
    case "auto_port_exhausted": return "settings.remote.error.auto_port_exhausted";
    case "acknowledgment_required": return "settings.remote.error.acknowledgment_required";
    case "custom_port_unavailable": return "settings.remote.error.custom_port_unavailable";
    case "bind_address_unavailable": return "settings.remote.error.bind_address_unavailable";
    case "bind_address_in_use": return "settings.remote.error.bind_address_in_use";
    case "remote_port_unavailable": return "settings.remote.error.remote_port_unavailable";
    case "bind_permission_denied": return "settings.remote.error.bind_permission_denied";
    default: return "settings.remote.error.remote_listener_failed";
  }
}
