import { isRosterFallbackGroup, RosterFallbackNotice } from "../../../ai-gateway/client/roster-fallback.js";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type MutableRefObject, type ReactNode } from "react";

import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "../../../execution/shared/operations/types.js";
import { isFleetMobileShell } from "@fleet-console/link/core";

import { ComposerAttachmentTray } from "../../../execution/client/composer-primitives/attachment-surface.js";
import { ComposerDeckCategory } from "../../../execution/client/composer-primitives/deck.js";
import { type ComposerAttachments } from "../../../execution/client/composer-primitives/attachment-store.js";
import { type ComposerMessageKey } from "../../../execution/client/composer-primitives/messages.js";
import type { Translate } from "@fleet-console/i18n";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationSearchEntry } from "../../../../core/client/src/integration/operation-search.js";
import { MobileIcon } from "../../../../core/client/src/chrome/mobile/mobile-icons.js";
import { MobileSheet } from "../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushBackLayer } from "../../../../core/client/src/chrome/mobile/mobile-back.js";
import { reportSheetChrome, reportShellChrome } from "../../../../core/client/src/chrome/mobile/mobile-chrome.js";
import { pushOverlayHistory, releaseOverlayHistory, runAfterOverlayRelease } from "../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { isMentionSelectable, mentionTargetName, type MentionTarget, type PluginMentionRow } from "./new-session-mention.js";
import { TheaterAvatar } from "../theater-avatar.js";
import { resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { MobileEffortGateRow, MobileEffortTabs, Toggle, useMobileEffortGate } from "../../../execution/client/components/mobile-effort-gate.js";
import "../../../execution/client/components/mobile-launch-sheet.css";

/**
 * 모바일 「새 작업」 시트(S-11a~e). 상태·효과·제출은 새 세션 컨테이너(mobile-new-session.tsx)가 소유하고, 이 화면은
 * 그 값과 콜백을 받아 모바일 문법으로만 그린다. 모델 시트는 현행 모델 그룹의 모델과 강도 글자 탭,
 * 옵션 묶음은 게이트 펼치기 · 다이나믹 워크플로우다(D20·D41). 하네스·시작 보기 선택은 없다 — 폰의 새 작업은 늘
 * 채팅으로 열리고(실효값은 데스크톱 컴포넌트가 정한다), 실행 하네스는 그룹과 무관하게 같다(NT).
 */

type Sub = "theater" | "model" | "attach";

interface Attachment { readonly key: string; readonly name: string; readonly previewUrl: string; readonly uploading: boolean }

export interface MobileNewSessionSheetProps {
  readonly inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly prompt: string;
  readonly onPromptChange: (value: string, element: HTMLTextAreaElement) => void;
  readonly theaters: readonly { readonly id: string; readonly label: string }[];
  readonly theaterId: string | null;
  readonly onTheater: (id: string) => void;
  readonly groups: readonly OperationLaunchVariantGroup[];
  readonly selectedRow: OperationLaunchVariantRow | null;
  readonly effort: string | null;
  readonly onModelRow: (row: OperationLaunchVariantRow) => void;
  readonly onEffort: (effort: string | null) => void;
  readonly ultracodeArmed: boolean;
  readonly hasUltracodeWord: boolean;
  readonly onUltracode: (on: boolean) => void;
  readonly attachments: readonly Attachment[];
  readonly attachmentStore: ComposerAttachments;
  readonly attachmentT: Translate<ComposerMessageKey>;
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (key: string) => void;
  readonly mentionDeckOpen: boolean;
  readonly mentionEntries: readonly OperationSearchEntry[];
  /** 「시작 전」 Operation — 데스크톱 새 세션 '@'와 같은 원천(`useMentionSources().pendingGroups`)이다. */
  readonly pendingMentionEntries: readonly OperationSearchEntry[];
  readonly pluginMentionRows: readonly PluginMentionRow[];
  readonly mentionTarget: MentionTarget | null;
  readonly onPickMention: (target: MentionTarget) => void;
  readonly onClearMention: () => void;
  /** 바의 상태 줄과 같은 한 줄(상한 초과 · 첨부 · 멘션 전달 · 실행 거절). */
  readonly message: string | null;
  readonly canSubmit: boolean;
  readonly submitting: boolean;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
  </svg>
);

function Radio({ on }: { readonly on: boolean }) {
  return <span className={`mls-radio${on ? " is-on" : ""}`} aria-hidden="true" />;
}

export function MobileNewSessionSheet(props: MobileNewSessionSheetProps) {
  const t = useT();
  const { inputRef, prompt, theaters, theaterId, groups, selectedRow, effort, onSubmit, onClose } = props;
  const [sub, setSub] = useState<Sub | null>(null);
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const inApp = isFleetMobileShell();

  // 하드웨어·브라우저 뒤로는 화면을 떠나지 않고 시트를 닫는다 — 시트 한 겹마다 history 항목 하나(셸 시트와 같은 계약).
  // 앱의 하드웨어 뒤로(`window.__fleetMobileBack`)는 history가 아니라 셸의 겹침 레지스트리를 맨 위부터 닫는다 — 같은 닫기를
  // 두 길에 올려 두고, 닫히면(어느 길이든) 둘 다 걷는다.
  const sheetHistoryRef = useRef<number | null>(null);
  useEffect(() => {
    const id = pushOverlayHistory(() => { sheetHistoryRef.current = null; onClose(); });
    sheetHistoryRef.current = id;
    const releaseLayer = pushBackLayer(() => onClose());
    return () => {
      releaseLayer();
      if (sheetHistoryRef.current !== null) releaseOverlayHistory(sheetHistoryRef.current);
      sheetHistoryRef.current = null;
    };
    // 열려 있는 동안 한 번 — 닫기 콜백은 store 동작이라 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 시트가 떠 있는 동안 앱의 아래 시스템 바는 시트 면이다(S-03) — 셸 시트와 같은 신호를 보내고, 닫히면 셸 상태(셸 시트)로 되돌린다.
  useEffect(() => {
    reportSheetChrome();
    return () => {
      reportShellChrome();
    };
  }, []);
  // 하위 시트에서 새 작업 시트로 돌아올 때는 입력칸에 포커스를 되돌리지 않는다 — 폰에서는 키보드가 다시 떠 뒤로를 한 번 더 눌러야 한다.
  // (시트 골격은 열릴 때 첫 입력에 포커스를 주므로 그 직후에 거둔다. 자식 효과가 먼저 돌아 이 효과가 마지막이다.)
  const previousSubRef = useRef<Sub | null>(null);
  useEffect(() => {
    const returning = previousSubRef.current !== null && sub === null;
    previousSubRef.current = sub;
    if (returning && document.activeElement === inputRef.current) inputRef.current?.blur();
  }, [sub, inputRef]);
  const subHistoryRef = useRef<number | null>(null);
  useEffect(() => {
    if (sub === null) return;
    const id = pushOverlayHistory(() => { subHistoryRef.current = null; setSub(null); });
    subHistoryRef.current = id;
    const releaseLayer = pushBackLayer(() => setSub(null));
    return () => {
      releaseLayer();
      if (subHistoryRef.current === id) { subHistoryRef.current = null; releaseOverlayHistory(id); }
    };
  }, [sub]);

  // 시트 안에서 다른 화면으로 가는 길(폴백 표식의 「AI Gateway 열기」) — 하위 시트와 새 작업 시트의 history 항목을 위에서부터
  // 걷고, 시트를 닫은 다음에 옮긴다. 그래야 옮긴 화면이 걷히지 않고, 뒤로는 시트가 아니라 원래 화면으로 간다.
  const leaveSheet = (go: () => void) => {
    const subId = subHistoryRef.current;
    subHistoryRef.current = null;
    const sheetId = sheetHistoryRef.current;
    sheetHistoryRef.current = null;
    runAfterOverlayRelease(subId, () => runAfterOverlayRelease(sheetId, () => { onClose(); go(); }));
  };

  // 실행은 Operations 화면으로 옮겨 간다 — 시트의 history 항목을 먼저 걷은 뒤에 보내야 이동한 화면이 걷히는 쪽에 끼지 않는다.
  // 멘션 전달은 화면을 옮기지 않고 실패하면 시트가 남으므로 그대로 보낸다.
  const start = () => {
    if (!props.canSubmit) return;
    if (props.mentionTarget !== null) { onSubmit(); return; }
    const id = sheetHistoryRef.current;
    sheetHistoryRef.current = null;
    runAfterOverlayRelease(id, onSubmit);
  };

  const theater = theaters.find((candidate) => candidate.id === theaterId) ?? null;
  // 하네스 선택이 없으므로 그룹(Claude · Gateway 공급자)이 둘 이상이면 모델 시트가 모든 그룹을 소제목으로 나눠 나열한다 —
  // 그래야 어느 그룹에 서 있든 다른 그룹 모델로 옮겨 갈 수 있다. 하나뿐이면 소제목 없이 그 그룹만 그린다.
  const grouped = groups.length > 1;
  const modelGroups = grouped ? groups : groups.slice(0, 1);
  const autoLabel = t("launchVariants.effort.auto");
  const fallbackBadge = t("settings.models.fallback");
  const { deck, toggleGate } = useMobileEffortGate(selectedRow, effort, autoLabel, props.onEffort);
  const effortLabel = deck.options.find((option) => option.checked)?.label ?? autoLabel;
  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setSub(null);
    if (files.length > 0) props.onAddFiles(files);
  };

  if (sub === "theater") {
    return (
      <MobileSheet key="theater" title={t("chrome.launch.mobile.theater")} onClose={() => setSub(null)} className="mls-sheet">
        {theaters.map((candidate) => (
          <button key={candidate.id} type="button" className="mobile-sheet-row" aria-current={candidate.id === theaterId ? "true" : undefined} onClick={() => { props.onTheater(candidate.id); setSub(null); }}>
            <TheaterAvatar theaterId={candidate.id} size={28} label={candidate.label} decorative />
            <span className="mobile-sheet-row-copy">{candidate.label}</span>
            {candidate.id === theaterId ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
          </button>
        ))}
      </MobileSheet>
    );
  }

  if (sub === "model") {
    return (
      <MobileSheet key="model" title={t("chrome.launch.mobile.model")} onClose={() => setSub(null)} className="mls-sheet">
        {modelGroups.map((candidate, index) => (
          <Fragment key={candidate.id}>
            {isRosterFallbackGroup(candidate.id) ? <RosterFallbackNotice className="mls-glab" onFollow={leaveSheet} /> : grouped ? <h3 className={`mls-glab${index > 0 ? " is-next" : ""}`}>{candidate.label}</h3> : null}
            <div className="mls-grp" role="radiogroup" aria-label={grouped ? candidate.label : t("chrome.launch.mobile.model")}>
              {candidate.rows.map((row) => (
                <button key={row.id} type="button" role="radio" aria-checked={row.id === selectedRow?.id} className="mls-gr" onClick={() => props.onModelRow(row)}>
                  <Radio on={row.id === selectedRow?.id} /><span className="mls-gr-tx">{row.label}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ))}
        {selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? (
          <>
            <h3 className="mls-glab">{t("chrome.launch.mobile.effort")}</h3>
            <MobileEffortTabs deck={deck} label={t("chrome.launch.mobile.effort")} onPick={props.onEffort} />
          </>
        ) : null}
        <h3 className="mls-glab is-options">{t("chrome.launch.mobile.options")}</h3>
        <div className="mls-grp">
          <MobileEffortGateRow deck={deck} onToggle={toggleGate} />
          <button type="button" role="switch" aria-checked={props.ultracodeArmed} className="mls-gr is-two" onClick={() => props.onUltracode(!props.ultracodeArmed)}>
            <span className="mls-gr-tx">
              {t("chrome.launch.mobile.dynamic")}
              <small>{props.ultracodeArmed ? t("chrome.launch.ultracodeNotice") : t("chrome.launch.mobile.dynamicOff")}</small>
            </span>
            <Toggle on={props.ultracodeArmed} />
          </button>
        </div>
      </MobileSheet>
    );
  }

  if (sub === "attach") {
    return (
      <MobileSheet key="attach" title={t("chrome.launch.mobile.attach")} onClose={() => setSub(null)} className="mls-sheet">
        <button type="button" className="mobile-sheet-row" disabled={inApp} onClick={() => cameraRef.current?.click()}>
          <span className="mobile-sheet-row-glyph"><CameraIcon /></span>
          <span className="mobile-sheet-row-copy">{t("chrome.launch.mobile.takePhoto")}</span>
        </button>
        <button type="button" className="mobile-sheet-row" disabled={inApp} onClick={() => libraryRef.current?.click()}>
          <span className="mobile-sheet-row-glyph"><MobileIcon name="file" /></span>
          <span className="mobile-sheet-row-copy">{t("chrome.launch.mobile.pickPhoto")}</span>
        </button>
        {inApp ? <p className="mls-secnote">{t("chrome.launch.mobile.attachUnavailable")}</p> : null}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPickFiles} />
        <input ref={libraryRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
      </MobileSheet>
    );
  }

  const operationRow = (entry: OperationSearchEntry) => {
    const selectable = isMentionSelectable(entry.activity);
    return (
      <button key={`op-${entry.operationId}`} type="button" className="mls-mention-row" disabled={!selectable} onClick={() => props.onPickMention({ kind: "operation", entry })}>
        {/* 행의 주체는 Operation 하나다 — 그 아바타가 사이드바 칩과 같은 얼굴로 상태를 말한다. 이 목록은 Theater 머리 없이
            여러 Theater 를 섞으므로, 예전 이니셜이 하던 소속 구별은 이름 아래 Theater 이름이 잇는다(플러그인 행의 분류 줄과 같은 문법). */}
        <OperationNameMark
          operation={{ id: entry.operationId, parentOperationId: entry.parentOperationId }}
          status={resolveOperationMarkVisual({ activity: entry.activity, operationId: entry.operationId, idleArrivalIds })}
          size={24}
        />
        <span className="mls-mention-name">{entry.operationName}<small>{entry.theaterLabel}</small></span>
      </button>
    );
  };
  // 묶음 머리는 데스크톱 덱과 같은 문법(글자 + 오른쪽 구분선, SDK `ComposerDeckCategory`)이고 행이 있는 묶음에만 선다 —
  // Operations → 시작 전 → 플러그인 행선지(분류마다) 순서다.
  const pluginSections = props.pluginMentionRows.reduce<{ label: string; rows: PluginMentionRow[] }[]>((sections, row) => {
    const last = sections[sections.length - 1];
    if (last && last.label === row.categoryLabel) last.rows.push(row);
    else sections.push({ label: row.categoryLabel, rows: [row] });
    return sections;
  }, []);
  const mentionRows: ReactNode[] = props.mentionDeckOpen ? [
    ...(props.mentionEntries.length > 0 ? [<ComposerDeckCategory key="h-operations" label={t("conversation.newSession.deckOperations")} />, ...props.mentionEntries.map(operationRow)] : []),
    ...(props.pendingMentionEntries.length > 0 ? [<ComposerDeckCategory key="h-pending" label={t("conversation.newSession.deckPending")} />, ...props.pendingMentionEntries.map(operationRow)] : []),
    ...pluginSections.flatMap((section, at) => [
      <ComposerDeckCategory key={`h-plugin-${at}`} label={section.label} />,
      ...section.rows.map((row) => (
        <button key={`plugin-${row.optionId}`} type="button" className="mls-mention-row" onClick={() => props.onPickMention({ kind: "plugin", row })}>
          <span className="mls-mention-mark" aria-hidden="true">{row.renderMark?.() ?? "@"}</span>
          <span className="mls-mention-name">{row.label}{row.capabilityLabel ? <small>{row.capabilityLabel}</small> : null}</span>
        </button>
      )),
    ]),
  ] : [];

  return (
    // 시트마다 key가 다르다 — 같은 자리의 시트 인스턴스를 재사용하면 앞 시트의 닫히는 중 상태가 다음 시트에 남는다.
    <MobileSheet
      key="main"
      title={t("chrome.launch.mobile.title")}
      onClose={onClose}
      className="mls-sheet"
      footer={<button type="button" className="mobile-pill" disabled={!props.canSubmit} onClick={start}><MobileIcon name="send" size={18} />{t("chrome.launch.mobile.start")}</button>}
    >
      <div className="mls-compose">
        {mentionRows.length > 0 ? <div className="mls-mentions" role="listbox" aria-label={t("chrome.launch.mobile.inputLabel")}>{mentionRows}</div> : null}
        {props.mentionTarget ? (
          <button type="button" className="mobile-pill-secondary mls-mention-chip" aria-label={t("chrome.launch.mobile.mentionClear")} onClick={props.onClearMention}>
            @{mentionTargetName(props.mentionTarget)}<MobileIcon name="x" size={16} />
          </button>
        ) : null}
        <textarea
          ref={inputRef}
          className="mobile-field mls-input"
          value={prompt}
          placeholder={t("chrome.launch.mobile.placeholder")}
          aria-label={t("chrome.launch.mobile.inputLabel")}
          disabled={props.submitting}
          onChange={(event) => props.onPromptChange(event.target.value, event.currentTarget)}
        />
      </div>
      <ComposerAttachmentTray store={props.attachmentStore} t={props.attachmentT} disabled={props.submitting} />
      {props.mentionTarget === null ? (
        <div className="mls-chips">
          <button type="button" className="mls-circ" data-press="r3" aria-label={t("chrome.launch.mobile.attach")} onClick={() => setSub("attach")}><MobileIcon name="plus" size={20} /></button>
          <button type="button" className="mobile-pill-secondary mls-theater-chip" aria-label={theater ? t("chrome.launch.mobile.theaterChip", { name: theater.label }) : t("chrome.launch.mobile.theater")} onClick={() => setSub("theater")} disabled={theaters.length === 0}>
            {theater ? <TheaterAvatar theaterId={theater.id} size={20} label={theater.label} decorative /> : null}
            <span className="mls-chip-name">{theater?.label ?? t("chrome.launch.mobile.theater")}</span>
          </button>
          <button type="button" className="mobile-pill-secondary mls-model-chip" onClick={() => setSub("model")} disabled={!selectedRow}>
            <span className="mls-chip-name">{selectedRow ? (groups.some((group) => isRosterFallbackGroup(group.id) && group.rows.includes(selectedRow)) ? `${selectedRow.label} · ${fallbackBadge}` : selectedRow.label) : t("chrome.launch.modelUnset")}</span>{selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? <span className="mls-chip-effort">{effortLabel}</span> : null}
          </button>
        </div>
      ) : null}
      {props.message ? <p className="mls-message" role="alert">{props.message}</p> : <p className="mls-secnote">{t("chrome.launch.mobile.defaults")}</p>}
    </MobileSheet>
  );
}
