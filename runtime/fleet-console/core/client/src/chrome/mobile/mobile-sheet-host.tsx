import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { resolveOperationActivity } from "../../../../../features/execution/client/operation-activity.js";
import type { MobileConfirmSpec } from "@fleet-console/sdk/plugin";
import type { DeferredDeletionReceipt } from "../../integration/api.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "../../../../../features/workspace/client/theater.js";
import { TheaterAvatar } from "../../../../../features/workspace/client/theater-avatar.js";
import { openTheaterSystemPrompt } from "../../../../../features/settings/client/theater-system-prompt-sheet.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { usePluginRegistry } from "../../integration/plugin-registry.js";
import { useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import { getState, openQuickLaunch, setActiveTheater } from "../../integration/store.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { globalShellEntry } from "../../../../../features/execution/client/terminal/global-shell/rail-panel.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { useMobileDestinationBindings } from "./mobile-destinations.js";
import type { ConsoleState } from "../../integration/types.js";
import { pushBackLayer } from "./mobile-back.js";
import { MobileFolderSheet } from "./mobile-folder-sheet.js";
import { MobileSettingsPage } from "./mobile-settings-page.js";
import { MobileIcon } from "./mobile-icons.js";
import { showMobileToast } from "./mobile-toast.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";
import { MobileSheet } from "./mobile-sheet.js";
import { closeMobileSheets, popMobileSheet, pushMobileSheet, setMobileDestination, useMobileSheetStack } from "./mobile-store.js";

/**
 * 하단 시트의 호스트. 쌓인 시트 가운데 맨 위 하나만 그리고, 닫으면 앞 시트로 돌아간다.
 * 쌓인 시트 전체가 history 항목 하나를 든다.
 */
export function MobileSheetHost({ state, onDeferredDeletion }: { readonly state: ConsoleState; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void }) {
  const t = useT();
  const stack = useMobileSheetStack();
  const depth = stack.length;
  const historyIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (depth === 0) {
      if (historyIdRef.current !== null) { releaseOverlayHistory(historyIdRef.current); historyIdRef.current = null; }
      return;
    }
    // 시트가 열려 있는 동안은 하드웨어 뒤로가 맨 위 시트를 먼저 닫는다.
    const releaseLayer = pushBackLayer(() => popMobileSheet());
    // 한 항목이 쌓인 모든 시트를 든다 — 뒤로가 시트를 하나 닫으면 남은 시트를 위해 이 효과가 항목을 다시 세운다.
    if (historyIdRef.current === null) {
      historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; popMobileSheet(); });
    }
    return releaseLayer;
  }, [depth]);

  const top = stack.at(-1);
  if (!top) return null;
  if (top.kind === "rename") return <RenameSheet key={top.operationId} state={state} operationId={top.operationId} />;
  if (top.kind === "console") return <ConsoleSheet />;
  if (top.kind === "create") return <CreateSheet state={state} />;
  if (top.kind === "profile") return <ProfileSheet />;
  if (top.kind === "custom") return <>{top.render(popMobileSheet)}</>;
  if (top.kind === "confirm") return <ConfirmSheet spec={top.spec} resolve={top.resolve} />;
  if (top.kind === "folder") return <MobileFolderSheet onClose={popMobileSheet} onConfirm={(path) => { closeMobileSheets(); void addTheaterWithToast(path, t); }} />;
  if (top.kind === "forget") return <ForgetSheet key={top.theaterId} state={state} theaterId={top.theaterId} onDeferredDeletion={onDeferredDeletion} />;
  return <TheaterSheet state={state} />;
}

/** 폴더를 Theater로 등록하고, 성공하면 「{이름}을(를) Theater로 추가했습니다」 토스트를 띄운다. 실패는 스토어의 theaterError가 화면에 말한다. */
async function addTheaterWithToast(path: string, t: ReturnType<typeof useT>): Promise<void> {
  await registerTheaterFromPath(path);
  const current = getState();
  if (current.theaterError !== null) return;
  const label = current.theaters.find((theater) => theater.id === current.activeTheaterId)?.label;
  if (label) showMobileToast(t("mobile.toast.theaterAdded", { name: label }));
}

/** S-13 — 입력칸 하나. 저장하면 닫히고 토스트가 알린다. 빈 문자열은 저장하지 않는다. */
function RenameSheet({ state, operationId }: { readonly state: ConsoleState; readonly operationId: string }) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const operation = state.operations.find((item) => item.id === operationId);
  const [value, setValue] = useState(operation?.title ?? "");
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    void capabilities.operations.rename(operationId, trimmed).then(() => { closeMobileSheets(); showMobileToast(t("mobile.toast.renamed")); }).catch(() => setSaving(false));
  };
  return (
    <MobileSheet
      title={t("mobile.sheet.rename.title")}
      onClose={popMobileSheet}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={popMobileSheet}>{t("mobile.sheet.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-inverse" onClick={save} disabled={trimmed === "" || saving}>{t("mobile.sheet.save")}</button>
      </>}
    >
      <input
        className="mobile-field"
        value={value}
        aria-label={t("mobile.sheet.rename.aria")}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
        autoFocus
      />
    </MobileSheet>
  );
}

/** S-07 — 지금 Theater를 바꾼다. 고르면 시트를 닫고 홈 목록이 그 Theater의 대화로 바뀐다. */
function TheaterSheet({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const cancel = () => popMobileSheet();
  const active = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const pluginRows = useTheaterSheetPluginRows(active?.id ?? null);
  return (
    <>
      <MobileSheet title={t("mobile.sheet.theater.title")} onClose={cancel}>
        {state.theaters.map((theater) => {
          const operations = state.operations.filter((operation) => operation.theaterId === theater.id);
          const awaiting = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
          const here = theater.id === state.activeTheaterId;
          return (
            <button
              type="button"
              className="mobile-sheet-row"
              key={theater.id}
              aria-current={here ? "true" : undefined}
              onClick={() => { setActiveTheater(theater.id); closeMobileSheets(); }}
            >
              <TheaterAvatar theaterId={theater.id} size={28} label="" decorative />
              <span className="mobile-sheet-row-copy">
                <strong>{theater.label}</strong>
                <small className={awaiting > 0 ? "is-awaiting" : undefined}>
                  {t("mobile.sheet.theater.summary", { count: operations.length })}{awaiting > 0 ? ` · ${t("mobile.sheet.theater.awaiting", { count: awaiting })}` : ""}
                </small>
              </span>
              {here ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
            </button>
          );
        })}
        <button type="button" className="mobile-sheet-row" onClick={() => pushMobileSheet({ kind: "folder" })} disabled={state.addingTheater}>
          <span className="mobile-sheet-row-glyph"><MobileIcon name="plus" /></span>
          <span className="mobile-sheet-row-copy"><strong>{t("mobile.sheet.theater.add")}</strong></span>
        </button>
        {state.theaterError !== null ? <p className="mobile-sheet-error" role="alert">{state.theaterError}</p> : null}
        {active ? (
          <>
            <div className="mobile-sheet-sep" role="separator" />
            <div className="mobile-sheet-group-label">{t("mobile.sheet.theater.current", { name: active.label })}</div>
            <button type="button" className="mobile-sheet-row" onClick={() => openTheaterSystemPrompt(active, null)}>
              <span className="mobile-sheet-row-glyph"><MobileIcon name="pencil" /></span>
              <span className="mobile-sheet-row-copy"><strong>{t("mobile.menu.prompt")}</strong></span>
            </button>
            {pluginRows.map((row) => (
              <button type="button" className="mobile-sheet-row" key={row.id} onClick={() => { closeMobileSheets(); row.run(); }}>
                <span className="mobile-sheet-row-glyph">{row.icon}</span>
                <span className="mobile-sheet-row-copy"><strong>{row.label}</strong></span>
              </button>
            ))}
            <button type="button" className="mobile-sheet-row" onClick={() => pushMobileSheet({ kind: "forget", theaterId: active.id })}>
              <span className="mobile-sheet-row-glyph"><MobileIcon name="minus" /></span>
              <span className="mobile-sheet-row-copy"><strong>{t("mobile.menu.forgetTheater")}</strong></span>
            </button>
          </>
        ) : null}
      </MobileSheet>
    </>
  );
}

interface TheaterSheetPluginRow { readonly id: string; readonly label: string; readonly icon: ReactNode; readonly run: () => void }

/** 플러그인이 `TheaterContribution.mobileRow`로 거는 행 — `subscribe`의 변화에 맞춰 다시 읽고, 글이 같으면 다시 그리지 않는다. */
function useTheaterSheetPluginRows(theaterId: string | null): readonly TheaterSheetPluginRow[] {
  const { theaterContributions } = usePluginRegistry();
  const locale = useConsoleLocale();
  const contributions = useMemo(() => theaterContributions.filter((contribution) => contribution.mobileRow !== undefined), [theaterContributions]);
  const version = () => contributions.map((contribution) => theaterId === null ? "" : contribution.mobileRow?.get(theaterId, locale)?.label ?? "").join("\u0001");
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = contributions.flatMap((contribution) => contribution.mobileRow ? [contribution.mobileRow.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    version,
    version,
  );
  return useMemo(() => {
    if (theaterId === null) return [];
    return contributions.flatMap((contribution) => {
      const row = contribution.mobileRow;
      const value = row?.get(theaterId, locale);
      return row && value ? [{ id: contribution.id, label: value.label, icon: value.icon, run: () => row.run(theaterId) }] : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key는 플러그인 행의 글이 바뀌었다는 신호다.
  }, [contributions, locale, theaterId, key]);
}

/** S-17 — 목록에서 빼기 확인. 폴더와 파일은 지우지 않는다. 되돌리기는 앱의 삭제 토스트가 맡는다. */
function ForgetSheet({ state, theaterId, onDeferredDeletion }: { readonly state: ConsoleState; readonly theaterId: string; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void }) {
  const t = useT();
  const theater = state.theaters.find((item) => item.id === theaterId);
  // 빼는 동안 Theater는 목록에서 먼저 사라진다 — 시트가 닫히기 전에 본문 이름이 비지 않게 마지막으로 본 이름을 붙든다.
  const labelRef = useRef(theater?.label ?? "");
  if (theater) labelRef.current = theater.label;
  const [busy, setBusy] = useState(false);
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    void forgetTheaterCompletely(theaterId).then((deletion) => { onDeferredDeletion(deletion); closeMobileSheets(); });
  };
  return (
    <MobileSheet
      title={t("mobile.sheet.forget.title")}
      onClose={popMobileSheet}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={popMobileSheet}>{t("mobile.sheet.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-danger" disabled={busy} onClick={confirm}>{t("mobile.sheet.forget.confirm")}</button>
      </>}
    >
      <p className="mobile-sheet-lead">{t("mobile.sheet.forget.body", { name: labelRef.current })}</p>
    </MobileSheet>
  );
}

/**
 * 프로필·설정 시트 — 홈 머리 왼쪽 아바타가 연다. X로 닫는 전체 높이 시트이고, 본문은 설정 목록(Console 정체 카드 · 화면 · 에이전트 · 사용 ·
 * 정보)이다. 행을 열면 시트를 닫고 `/settings` 상세 라우트로 가며, 상세의 ‹는 이 시트로 돌아온다. Console 카드는 전환기를 연다.
 */
function ProfileSheet() {
  const t = useT();
  return (
    <MobileSheet title={t("mobile.home.settings")} onClose={popMobileSheet} full className="is-profile" focusInputOnTouch={false}>
      <MobileSettingsPage embedded />
    </MobileSheet>
  );
}

/**
 * 홈 머리 +의 메뉴 — 새 대화(새 작업 시트), 새 터미널(Shell 목적지, 보일 때만), Theater 추가(폴더 시트).
 * 고르면 이 시트를 닫고 이어서 연다. Theater 추가는 시트 위에 쌓아 닫으면 이 메뉴로 돌아온다.
 */
function CreateSheet({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const bindings = useRailEntries();
  const shell = useMobileDestinationBindings(bindings, state.activeTheaterId).find((binding) => binding.entry.id === globalShellEntry.id);
  const hasTheater = state.activeTheaterId !== null;
  return (
    <MobileSheet title={t("mobile.create.title")} onClose={popMobileSheet}>
      <button type="button" className="mobile-sheet-row" disabled={!hasTheater} onClick={() => { closeMobileSheets(); openQuickLaunch(); }}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="newop" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.list.newConversation")}</strong><small>{t("mobile.create.conversationSub")}</small></span>
      </button>
      {shell ? (
        <button type="button" className="mobile-sheet-row" onClick={() => { closeMobileSheets(); setMobileDestination({ kind: "plugin", entryId: shell.entry.id }); }}>
          <span className="mobile-sheet-row-glyph"><MobileIcon name="term" /></span>
          <span className="mobile-sheet-row-copy"><strong>{t("mobile.create.terminal")}</strong><small>{t("mobile.create.terminalSub")}</small></span>
        </button>
      ) : null}
      <button type="button" className="mobile-sheet-row" onClick={() => pushMobileSheet({ kind: "folder" })}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="folder" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.sheet.theater.add")}</strong></span>
      </button>
    </MobileSheet>
  );
}

/** S-18 (브라우저, D12) — 이 Console 한 줄만. 다른 Console의 이름·주소·상태는 이 페이지에 오지 않는다. 앱에서는 네이티브가 같은 모양의 시트를 직접 띄운다. */
function ConsoleSheet() {
  const t = useT();
  const appearance = useMobileAppearance();
  const name = appearance.console?.label ?? window.location.hostname;
  return (
    <MobileSheet title={t("mobile.sheet.console.title")} onClose={popMobileSheet}>
      <div className="mobile-sheet-row" aria-current="true">
        <MobileMonogram label={name} toneKey={name} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? name.charAt(0).toUpperCase()} round size={36} />
        <span className="mobile-sheet-row-copy"><strong>{name}</strong><small>{t("mobile.sheet.console.connected")}</small></span>
        <MobileIcon name="check" className="mobile-sheet-check" />
      </div>
    </MobileSheet>
  );
}

/** 플러그인이 `confirm`으로 띄운 확인 시트(예: S-14 채팅으로 보기). 확정이면 true, 취소·닫기·뒤로면 false로 한 번만 답한다. */
function ConfirmSheet({ spec, resolve }: { readonly spec: MobileConfirmSpec; readonly resolve: (confirmed: boolean) => void }) {
  const answered = useRef(false);
  const answer = (confirmed: boolean) => { if (answered.current) return; answered.current = true; resolve(confirmed); };
  // 어떤 경로로 내려가든(뒤로·스크림·끌어내리기) 답이 빠지지 않게 한다.
  useEffect(() => () => answer(false), []);
  return (
    <MobileSheet
      title={spec.title}
      onClose={popMobileSheet}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={() => { answer(false); popMobileSheet(); }}>{spec.cancelLabel}</button>
        <button type="button" className="mobile-pill-secondary is-inverse" onClick={() => { answer(true); popMobileSheet(); }}>{spec.confirmLabel}</button>
      </>}
    >
      <p className="mobile-sheet-lead">{spec.body}</p>
    </MobileSheet>
  );
}
