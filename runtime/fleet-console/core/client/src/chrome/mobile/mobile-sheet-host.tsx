import { commodoreAliasEditor } from "../../integration/commodore-identity.js";
import { getViewedTheaterId } from "../../integration/viewed-theater.js";
import { useEffect, useRef, useState } from "react";

import type { MobileConfirmSpec } from "../../../../../features/workspace/shared/mobile.js";
import { addCommodoreTheaterFromPath } from "../../../../../features/commodore/client/theaters-api.js";
import { describeTheaterRegistrationError } from "../../integration/failure-notices.js";
import { requestCommodoreCreate } from "../../../../../features/commodore/client/commodore-create-modal.js";
import { requestTaskforceCreate } from "../../../../../features/commodore/client/taskforce/taskforce.js";
import { taskforceT } from "../../../../../features/commodore/client/taskforce/i18n.js";
import { CommodoreDeleteFlow } from "../../../../../features/commodore/client/commodore-delete-body.js";
import { announceCommodoreDeletion, subscribeCommodoreLifecycle, wasCommodoreRemoved } from "../../../../../features/commodore/client/commodore-delete-events.js";
import { commodoreSectionLabel, readCommodoreList, refreshCommodoreList, setZoneCommodore, useCommodoreList, useCommodoreSidebarLayout, useMobileCommodoreSelection, selectMobileCommodore } from "../../../../../features/commodore/client/commodore-list.js";
import { openCommodoreMobile } from "../../../../../features/commodore/client/commodore-state.js";
import { useCommodoreSidebarCommands } from "../../../../../features/commodore/client/sidebar-sections.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { IdentityTone } from "../../../../../features/workspace/shared/identity-tones.js";
import { commodoreAvatarKey, pickMongleBase } from "../../../../../features/workspace/shared/avatars.js";
import { setMongleLook, useMongleLook } from "../../../../../features/workspace/client/avatar-events.js";
import { MongleAvatarPicker, type MongleAvatarPreviewState } from "../../../../../features/workspace/client/components/mongle-avatar-picker.js";
import { MongleAvatar } from "../../../../../features/workspace/client/components/mongle-avatar.js";
import { useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import { getState, openMobileNewSession } from "../../integration/store.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { globalShellEntry } from "../../../../../features/execution/client/terminal/global-shell/rail-panel.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { mobileHomeCommodoreId, useMobileDestinationBindings } from "./mobile-destinations.js";
import type { ConsoleState } from "../../integration/types.js";
import { pushBackLayer } from "./mobile-back.js";
import { MobileFolderSheet } from "./mobile-folder-sheet.js";
import { MobileSettingsPage } from "./mobile-settings-page.js";
import { MobileIcon } from "./mobile-icons.js";
import { showMobileToast } from "./mobile-toast.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";
import { MobileSheet } from "./mobile-sheet.js";
import { getMobileSheetStack, closeMobileSheets, openMobilePluginDestination, popMobileSheet, pushMobileSheet, setMobileListTheater, useMobileSheetStack } from "./mobile-store.js";

/**
 * 하단 시트의 호스트. 쌓인 시트 가운데 맨 위 하나만 그리고, 닫으면 앞 시트로 돌아간다.
 * 쌓인 시트 전체가 history 항목 하나를 든다.
 */
export function MobileSheetHost({ state }: { readonly state: ConsoleState }) {
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
    const back = () => {
      const current = getMobileSheetStack().at(-1);
      if (current?.kind === "custom" && current.onBack) current.onBack(); else popMobileSheet();
    };
    const releaseLayer = pushBackLayer(back);
    // 확인 패널의 뒤로·busy 무시는 스택 깊이를 바꾸지 않는다. 이미 걷힌 history 항목도 다시 받친다.
    const fromHistory = () => {
      historyIdRef.current = null;
      back();
      if (getMobileSheetStack().length) historyIdRef.current = pushOverlayHistory(fromHistory);
    };
    if (historyIdRef.current === null) historyIdRef.current = pushOverlayHistory(fromHistory);
    return releaseLayer;
  }, [depth]);

  const top = stack.at(-1);
  if (!top) return null;
  if (top.kind === "rename") return <RenameSheet key={top.objectiveId} state={state} objectiveId={top.objectiveId} />;
  if (top.kind === "console") return <ConsoleSheet />;
  if (top.kind === "create") return <CreateSheet state={state} />;
  if (top.kind === "profile") return <ProfileSheet />;
  if (top.kind === "custom") return <>{top.render(popMobileSheet)}</>;
  if (top.kind === "confirm") return <ConfirmSheet spec={top.spec} resolve={top.resolve} />;
  if (top.kind === "folder") return <MobileFolderSheet onClose={popMobileSheet} onConfirm={(path) => { closeMobileSheets(); void addTheaterWithToast(path, t); }} />;
  return <TheaterSheet />;
}

/** 사령관이 있으면 그 목록에만 더한다. 사령관이 없으면 새 사령관 만들기 흐름으로 이어진다. */
async function addTheaterWithToast(path: string, t: ReturnType<typeof useT>): Promise<void> {
  const commodoreId = mobileHomeCommodoreId();
  if (!commodoreId) {
    requestCommodoreCreate();
    return;
  }
  try {
    const theaterId = await addCommodoreTheaterFromPath(commodoreId, path);
    if (!theaterId) return;
    await refreshCommodoreList();
    const label = readCommodoreList().find((row) => row.commodoreId === commodoreId)?.theaters.find((row) => row.theaterId === theaterId)?.label;
    if (label) showMobileToast(t("mobile.toast.theaterAdded", { name: label }));
  } catch (error) { showMobileToast(describeTheaterRegistrationError(error, t)); }
}

/** S-13 — 입력칸 하나. 저장하면 닫히고 토스트가 알린다. 빈 문자열은 저장하지 않는다. */
function RenameSheet({ state, objectiveId }: { readonly state: ConsoleState; readonly objectiveId: string }) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const objectiveRecord = state.objectiveRecords.find((item) => item.id === objectiveId);
  const [value, setValue] = useState(objectiveRecord?.title ?? "");
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    void capabilities.objectiveRecords.rename(objectiveId, trimmed).then(() => { closeMobileSheets(); showMobileToast(t("mobile.toast.renamed")); }).catch(() => setSaving(false));
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

/** 사령관 목록에서 전환한다. 빈 목록을 전역 Theater 등록부로 대체하지 않는다. */
function TheaterSheet() {
  const t = useT();
  const commodores = useCommodoreList();
  const selected = useMobileCommodoreSelection();
  const cancel = () => popMobileSheet();
  return (
    <MobileSheet title={t("sidebar.commodore.fallback")} onClose={cancel}>
      {commodores.map((commodore) => {
        const label = commodoreSectionLabel(commodore, t("sidebar.commodore.fallback"));
        return (
          <div key={commodore.commodoreId} className="mobile-sheet-row is-theater is-split">
            <button type="button" className="mobile-sheet-row-main" aria-current={selected === commodore.commodoreId ? "true" : undefined} onClick={() => { selectMobileCommodore(commodore.commodoreId); const home = commodore.theaters.find((theater) => theater.theaterId)?.theaterId ?? null; setMobileListTheater(home ? { commodoreId: commodore.commodoreId, theaterId: home } : null); closeMobileSheets(); }}>
              <span className="mobile-sheet-row-copy"><strong>{label}</strong></span>
            </button>
            <button type="button" className="mobile-sheet-kebab" aria-label={t("sidebar.theater.actionsMenuAria", { theater: label })} onClick={() => pushMobileSheet({ kind: "custom", render: (dismiss) => <CommodoreRowActions commodoreId={commodore.commodoreId} label={label} alias={commodore.alias ?? ""} onClose={dismiss} /> })}>
              <MobileIcon name="kebab" />
            </button>
          </div>
        );
      })}
      <button type="button" className="mobile-sheet-row" onClick={() => runAfterSheetRelease(requestCommodoreCreate)}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="plus" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.create.commodore")}</strong></span>
      </button>
      <TaskforceCreateSheetRow />
      <div className="mobile-sheet-sep" role="separator" />
      <p className="mobile-sheet-hint">{t("mobile.sheet.commodore.actionsHint")}</p>
    </MobileSheet>
  );
}

/** 사령관 칩 시트의 ⋯. 설정(맨 위가 그 사령관의 Theater)과 이름·모양 별칭. 길게 누르기에 기대지 않는다. */
export function CommodoreRowActions({ commodoreId, label, alias, onClose }: { readonly commodoreId: string; readonly label: string; readonly alias: string; readonly onClose: () => void }) {
  const t = useT();
  // Theater 목록은 그 사령관 「설정」 맨 위에 있다 — 다른 사령관과 나누는 목록 시트를 따로 띄우지 않는다.
  // 시트의 history 항목이 걷힌 뒤에 옮긴다 — 먼저 옮기면 세부의 깊이 항목이 걷히는 시트 항목과 뒤엉켜 뒤로가 주소만 홈으로 돌린다.
  const openSettings = () => {
    setZoneCommodore(commodoreId);
    runAfterSheetRelease(() => openCommodoreMobile("settings", commodoreId, true));
  };
  useDismissRemovedCommodore(commodoreId, onClose);
  const openAppearance = () => openCommodoreLookSheet(commodoreId, label, alias);
  const layout = useCommodoreSidebarLayout();
  const currentSection = layout.sections.find((section) => section.id === layout.membership[commodoreId]);
  const openMove = () => pushMobileSheet({ kind: "custom", render: (dismiss) => <CommodoreSectionMoveSheet commodoreId={commodoreId} onClose={dismiss} /> });
  return (
    <MobileSheet title={label} onClose={onClose}>
      <button type="button" className="mobile-sheet-row" onClick={openSettings}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="spark" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.commodore.settings")}</strong></span>
      </button>
      <button type="button" className="mobile-sheet-row" onClick={openAppearance}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="pencil" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("sidebar.commodore.appearance")}</strong></span>
      </button>
      {layout.sections.length > 0 ? <button type="button" className="mobile-sheet-row" onClick={openMove}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="folder" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("sidebar.commodoreSection.move")}</strong><small>{currentSection?.name ?? t("sidebar.commodoreSection.none")}</small></span>
        <MobileIcon name="right" />
      </button> : null}
      <div className="mobile-sheet-sep" role="separator" />
      <button type="button" className="mobile-sheet-row is-danger" onClick={() => openCommodoreDeleteSheet(commodoreId)}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="trash" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("sidebar.commodore.delete")}</strong></span>
      </button>
    </MobileSheet>
  );
}

function CommodoreSectionMoveSheet({ commodoreId, onClose }: { readonly commodoreId: string; readonly onClose: () => void }) {
  const t = useT();
  const sections = useCommodoreSidebarCommands();
  useDismissRemovedCommodore(commodoreId, onClose);
  const current = sections.layout.membership[commodoreId] ?? null;
  const move = async (sectionId: string | null) => {
    // targetId 없는 이동은 대상 섹션 끝에 놓는다. 다른 창의 행 순서를 덮어쓰지 않는다.
    const result = await sections.run({ op: "move", commodoreId, sectionId });
    if (result) closeMobileSheets();
  };
  return <MobileSheet title={t("sidebar.commodoreSection.move")} onClose={onClose} dismissible={!sections.busy}>
    {sections.error ? <p className="mobile-sheet-error" role="alert">{t("sidebar.commodoreSection.error")}</p> : null}
    {[...sections.layout.sections, { id: null, name: t("sidebar.commodoreSection.none") }].map((section) => (
      <button key={section.id ?? "none"} type="button" className="mobile-sheet-row" aria-current={current === section.id ? "true" : undefined}
        disabled={sections.busy || current === section.id} onClick={() => { void move(section.id); }}>
        <span className="mobile-sheet-row-copy"><strong>{section.name}</strong></span>
        {current === section.id ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
      </button>
    ))}
  </MobileSheet>;
}

function useDismissRemovedCommodore(commodoreId: string, onClose: () => void): void {
  useEffect(() => {
    if (wasCommodoreRemoved(commodoreId)) { onClose(); return; }
    return subscribeCommodoreLifecycle((event) => { if (event.op === "removed" && event.commodoreId === commodoreId) onClose(); });
  }, [commodoreId, onClose]);
}

/** 삭제 확인 시트의 두 단계는 하나의 history 항목을 함께 쓴다. */
export function openCommodoreDeleteSheet(commodoreId: string): void {
  const control = { back: () => {} };
  pushMobileSheet({ kind: "custom", onBack: () => control.back(), render: (dismiss) => <CommodoreDeleteSheet commodoreId={commodoreId} dismiss={dismiss} control={control} /> });
}
function CommodoreDeleteSheet({ commodoreId, dismiss, control }: { readonly commodoreId: string; readonly dismiss: () => void; readonly control: { back: () => void } }) {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  return <CommodoreDeleteFlow commodoreId={commodoreId} language={language} mobile onClose={dismiss} onBackHandler={(back) => { control.back = back; }}
    onComplete={(notice) => runAfterSheetRelease(() => announceCommodoreDeletion(notice))}
    renderFrame={(frame) => <MobileSheet title={frame.title} onClose={frame.close} full className="commodore-delete-sheet" focusInputOnTouch={false}
      dismissible={!frame.busy} scrimDismissible={frame.step === 1} describedBy={frame.questionId} footer={frame.footer}>{frame.body}</MobileSheet>} />;
}

export function openCommodoreLookSheet(commodoreId: string, label: string, alias: string): void {
  pushMobileSheet({ kind: "custom", render: (dismiss) => <CommodoreAliasSheet commodoreId={commodoreId} label={label} alias={alias} onClose={dismiss} /> });
}

function CommodoreAliasSheet({ commodoreId, label, alias, onClose }: { readonly commodoreId: string; readonly label: string; readonly alias: string; readonly onClose: () => void }) {
  useDismissRemovedCommodore(commodoreId, onClose);
  const t = useT();
  const locale = useConsoleLocale() === "ko" ? "ko" : "en";
  const look = useMongleLook(commodoreAvatarKey(commodoreId));
  const [value, setValue] = useState(alias);
  const [base, setBase] = useState(look.base);
  const [tone, setTone] = useState<IdentityTone | null>(look.tone);
  const [preview, setPreview] = useState<MongleAvatarPreviewState>("idle");
  const [saving, setSaving] = useState(false);
  const composingRef = useRef(false);
  const lookChanged = base !== look.base || tone !== look.tone;
  const save = () => {
    if (saving) return;
    const next = commodoreAliasEditor.clamp(value).trim();
    const saved = next.length > 0 ? next : null;
    const nameChanged = saved !== (alias || null);
    if (!nameChanged && !lookChanged) { onClose(); return; }
    setSaving(true);
    void (async () => {
      if (nameChanged) await commodoreAliasEditor.save(commodoreId, saved);
      if (lookChanged) {
        const wrote = await setMongleLook(commodoreAvatarKey(commodoreId), base, tone);
        if (!wrote) throw new Error("avatar");
      }
      void refreshCommodoreList();
      closeMobileSheets();
      showMobileToast(t(saved === null && nameChanged ? "mobile.toast.aliasCleared" : "mobile.toast.aliasSaved"));
    })().catch(() => setSaving(false));
  };
  return (
    <MobileSheet title={t("sidebar.commodore.appearance")} onClose={onClose}>
      {/* 고르는 모양·색·상태 미리보기를 연기하는 큰 얼굴 — 편집기 격자는 늘 대기 중 얼굴이다. */}
      <div className="mobile-avatar-hero"><MongleAvatar base={base} tone={tone} role="commodore" state={preview} size={88} label={label} decorative /></div>
      <input
        className="mobile-field"
        value={value}
        placeholder={label}
        aria-label={t("sidebar.theater.alias.inputAria", { theater: label })}
        onChange={(event) => setValue(composingRef.current ? event.target.value : commodoreAliasEditor.clamp(event.target.value))}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(event) => { composingRef.current = false; setValue(commodoreAliasEditor.clamp(event.currentTarget.value)); }}
        onKeyDown={(event) => { if (event.key === "Enter" && !composingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } }}
        autoFocus
      />
      <MongleAvatarPicker
        role="commodore"
        base={base}
        tone={tone}
        previewState={preview}
        locale={locale}
        dirty={value.trim() !== alias.trim() || lookChanged}
        busy={saving}
        labels={{
          heading: t("sidebar.commodore.shape"),
          reroll: t("avatar.editor.reroll"),
          reset: t("avatar.editor.reset"),
          preview: t("avatar.editor.preview"),
          cancel: t("mobile.sheet.cancel"),
          apply: t("mobile.sheet.save"),
          toneGroup: t("avatar.editor.toneGroup"),
          baseGroup: t("avatar.editor.baseGroup"),
          states: { running: t("avatar.state.running"), awaiting: t("avatar.state.awaiting"), unseen: t("avatar.state.unseen"), idle: t("avatar.state.idle"), ended: t("avatar.state.ended") },
          tones: { cerulean: t("avatar.tone.cerulean"), teal: t("avatar.tone.teal"), amber: t("avatar.tone.amber"), plum: t("avatar.tone.plum"), rose: t("avatar.tone.rose"), moss: t("avatar.tone.moss"), indigo: t("avatar.tone.indigo"), crimson: t("avatar.tone.crimson") },
        }}
        onBase={setBase}
        onTone={setTone}
        onPreviewState={setPreview}
        onReroll={() => setBase(pickMongleBase(new Set([base])))}
        onReset={() => { setBase(look.origin); setTone(null); }}
        onCancel={onClose}
        onApply={save}
      />
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
 * 시트를 닫고 다음 일을 한다 — 시트가 쌓아 둔 history 항목이 걷힌 뒤(popstate)에 한다. 걷히기 전에 하면 그 일이 쓰는 history가 걷히는
 * 항목과 뒤엉킨다: 목적지는 `?dest=`가 걷히는 항목에 쓰여 새로고침이 목록으로 돌아가고, 새 작업 시트는 자기 항목이 걷기에 밀려 표식 없이
 * 열려 브라우저 뒤로가 시트를 닫지 않고 페이지를 떠난다. 걷을 항목이 없으면 popstate가 없으니 짧은 시간 뒤에 한다.
 */
export function runAfterSheetRelease(action: () => void): void {
  const run = () => { window.removeEventListener("popstate", run); window.clearTimeout(timer); action(); };
  const timer = window.setTimeout(run, 400);
  window.addEventListener("popstate", run);
  closeMobileSheets();
}

/**
 * 홈 머리 +의 메뉴 — 새 대화(새 작업 시트), 새 터미널(Shell 목적지, 보일 때만), Theater 추가(폴더 시트).
 * 고르면 이 시트를 닫고 이어서 연다. Theater 추가는 시트 위에 쌓아 닫으면 이 메뉴로 돌아온다.
 */
function TaskforceCreateSheetRow() {
  const t = taskforceT(useConsoleLocale());
  return <button type="button" className="mobile-sheet-row" onClick={() => runAfterSheetRelease(() => requestTaskforceCreate())}>
    <span className="mobile-sheet-row-glyph"><MobileIcon name="plus" /></span>
    <span className="mobile-sheet-row-copy"><strong>{t("taskforce.new")}</strong></span>
  </button>;
}

function CreateSheet({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const bindings = useRailEntries();
  const shell = useMobileDestinationBindings(bindings, mobileHomeCommodoreId()).find((binding) => binding.entry.id === globalShellEntry.id);
  const hasTheater = getViewedTheaterId() !== null;
  return (
    <MobileSheet title={t("mobile.create.title")} onClose={popMobileSheet}>
      <button type="button" className="mobile-sheet-row" onClick={() => runAfterSheetRelease(requestCommodoreCreate)}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="plus" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.create.commodore")}</strong></span>
      </button>
      <TaskforceCreateSheetRow />
      <button type="button" className="mobile-sheet-row" disabled={!hasTheater} onClick={() => runAfterSheetRelease(() => openMobileNewSession())}>
        <span className="mobile-sheet-row-glyph"><MobileIcon name="newop" /></span>
        <span className="mobile-sheet-row-copy"><strong>{t("mobile.list.newConversation")}</strong><small>{t("mobile.create.conversationSub")}</small></span>
      </button>
      {shell ? (
        <button type="button" className="mobile-sheet-row" onClick={() => runAfterSheetRelease(() => openMobilePluginDestination(shell.entry.id, getViewedTheaterId()))}>
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
