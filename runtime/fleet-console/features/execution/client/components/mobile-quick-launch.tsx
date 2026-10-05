import { isRosterFallbackGroup, RosterFallbackNotice } from "../../../ai-gateway/client/roster-fallback.js";
import { Fragment, useEffect, useRef, useState, type ChangeEvent, type MutableRefObject, type ReactNode } from "react";

import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { isFleetMobileShell } from "@fleet-console/link/core";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationSearchEntry } from "../../../../core/client/src/integration/operation-search.js";
import { MobileIcon } from "../../../../core/client/src/chrome/mobile/mobile-icons.js";
import { MobileMonogram } from "../../../../core/client/src/chrome/mobile/mobile-monogram.js";
import { MobileSheet } from "../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushBackLayer } from "../../../../core/client/src/chrome/mobile/mobile-back.js";
import { reportSheetChrome, reportShellChrome } from "../../../../core/client/src/chrome/mobile/mobile-chrome.js";
import { pushOverlayHistory, releaseOverlayHistory, runAfterOverlayRelease } from "../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { buildQuickLaunchEffortDeck, isMentionSelectable, mentionTargetName, type QuickLaunchMentionTarget, type QuickLaunchPluginMentionRow } from "../quick-launch.js";
import "./mobile-quick-launch.css";

/**
 * 모바일 「새 작업」 시트(S-11a~e). 상태·효과·제출은 데스크톱 Quick Launch 컴포넌트가 그대로 소유하고, 이 화면은
 * 그 값과 콜백을 받아 모바일 문법으로만 그린다 — 로직 사본이 없다. 모델 시트는 현행 모델 그룹의 모델과 강도 글자 탭,
 * 옵션 묶음은 게이트 펼치기 · 다이나믹 워크플로우다(D20·D41). 하네스·시작 보기 선택은 없다 — 폰의 새 작업은 늘
 * 채팅으로 열리고(실효값은 데스크톱 컴포넌트가 정한다), 실행 하네스는 그룹과 무관하게 같다(NT).
 */

type Sub = "theater" | "model" | "attach";

interface Attachment { readonly key: string; readonly name: string; readonly previewUrl: string; readonly uploading: boolean }

export interface MobileQuickLaunchProps {
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
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (key: string) => void;
  readonly mentionDeckOpen: boolean;
  readonly mentionEntries: readonly OperationSearchEntry[];
  readonly pluginMentionRows: readonly QuickLaunchPluginMentionRow[];
  readonly mentionTarget: QuickLaunchMentionTarget | null;
  readonly onPickMention: (target: QuickLaunchMentionTarget) => void;
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

function Toggle({ on }: { readonly on: boolean }) {
  return <span className={`mql-toggle${on ? " is-on" : ""}`} aria-hidden="true" />;
}

function Radio({ on }: { readonly on: boolean }) {
  return <span className={`mql-radio${on ? " is-on" : ""}`} aria-hidden="true" />;
}

type EffortDeck = ReturnType<typeof buildQuickLaunchEffortDeck>;

/**
 * 모델 시트의 강도 게이트(S-11e ①) — 새 작업 시트와 Operation 입력창 모델 시트가 같은 규칙을 쓴다.
 * 기본은 일상 단계만 보이고, 「{tiers} 펼치기」를 켜면 게이트 뒤 단계가 탭 끝에 선다. 지금 값이 이미 게이트 단계면
 * 펼친 채로 시작한다(deck이 값으로 문을 붙든다). 펼치기를 끄면 게이트 단은 숨고, 그 단을 고른 상태였으면 바로 아래 일상 단으로 되돌린다.
 */
export function useMobileEffortGate(
  row: OperationLaunchVariantRow | null,
  effort: string | null,
  autoLabel: string,
  onEffort: (effort: string | null) => void,
): { readonly deck: EffortDeck; readonly toggleGate: () => void } {
  const [opened, setOpened] = useState(false);
  const deck = buildQuickLaunchEffortDeck(row, effort, autoLabel, "", opened);
  const toggleGate = () => {
    if (!deck.gateOpen) { setOpened(true); return; }
    if (deck.gateHeldByValue && row) {
      const gated = new Set(row.gatedEfforts ?? []);
      const everyday = (row.chips ?? []).filter((chip) => !gated.has(chip.id));
      onEffort(everyday.at(-1)?.id ?? null);
    }
    setOpened(false);
  };
  return { deck, toggleGate };
}

/** 「추론 강도」 글자 탭 한 줄 — 고른 칸은 text 600 + 아래 2(S-11b). */
export function MobileEffortTabs({ deck, label, onPick }: {
  readonly deck: EffortDeck;
  readonly label: string;
  readonly onPick: (effort: string | null) => void;
}) {
  return (
    <div className="mql-efft" role="radiogroup" aria-label={label}>
      {deck.options.map((option) => (
        <button key={option.id ?? "auto"} type="button" role="radio" aria-checked={option.checked} className={option.checked ? "is-on" : ""} onClick={() => onPick(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/** 「{tiers} 펼치기」 토글 행 — 고른 모델에 게이트 뒤 단계가 있을 때만 선다. */
export function MobileEffortGateRow({ deck, onToggle }: { readonly deck: EffortDeck; readonly onToggle: () => void }) {
  const t = useT();
  if (!deck.hasGate) return null;
  return (
    <button type="button" role="switch" aria-checked={deck.gateOpen} className="mql-gr" onClick={onToggle}>
      <span className="mql-gr-tx">{t("launchVariants.effort.apexToggle", { tiers: deck.gatedNames })}</span>
      <Toggle on={deck.gateOpen} />
    </button>
  );
}

export function MobileQuickLaunch(props: MobileQuickLaunchProps) {
  const t = useT();
  const { inputRef, prompt, theaters, theaterId, groups, selectedRow, effort, onSubmit, onClose } = props;
  const [sub, setSub] = useState<Sub | null>(null);
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
  // 시트가 떠 있는 동안 앱의 아래 시스템 바는 시트 면이다(S-03) — 셸 시트와 같은 신호를 보내고, 닫히면 셸 상태(드로어·셸 시트)로 되돌린다.
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
  useEffect(() => {
    if (sub === null) return;
    let id: number | null = pushOverlayHistory(() => { id = null; setSub(null); });
    const releaseLayer = pushBackLayer(() => setSub(null));
    return () => { releaseLayer(); if (id !== null) releaseOverlayHistory(id); };
  }, [sub]);

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
      <MobileSheet key="theater" title={t("chrome.quickLaunch.mobile.theater")} onClose={() => setSub(null)} className="mql-sheet">
        {theaters.map((candidate) => (
          <button key={candidate.id} type="button" className="mobile-sheet-row" aria-current={candidate.id === theaterId ? "true" : undefined} onClick={() => { props.onTheater(candidate.id); setSub(null); }}>
            <MobileMonogram label={candidate.label} toneKey={candidate.id} />
            <span className="mobile-sheet-row-copy">{candidate.label}</span>
            {candidate.id === theaterId ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
          </button>
        ))}
      </MobileSheet>
    );
  }

  if (sub === "model") {
    return (
      <MobileSheet key="model" title={t("chrome.quickLaunch.mobile.model")} onClose={() => setSub(null)} className="mql-sheet">
        {modelGroups.map((candidate, index) => (
          <Fragment key={candidate.id}>
            {isRosterFallbackGroup(candidate.id) ? <RosterFallbackNotice className="mql-glab" /> : grouped ? <h3 className={`mql-glab${index > 0 ? " is-next" : ""}`}>{candidate.label}</h3> : null}
            <div className="mql-grp" role="radiogroup" aria-label={grouped ? candidate.label : t("chrome.quickLaunch.mobile.model")}>
              {candidate.rows.map((row) => (
                <button key={row.id} type="button" role="radio" aria-checked={row.id === selectedRow?.id} className="mql-gr" onClick={() => props.onModelRow(row)}>
                  <Radio on={row.id === selectedRow?.id} /><span className="mql-gr-tx">{row.label}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ))}
        {selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? (
          <>
            <h3 className="mql-glab">{t("chrome.quickLaunch.mobile.effort")}</h3>
            <MobileEffortTabs deck={deck} label={t("chrome.quickLaunch.mobile.effort")} onPick={props.onEffort} />
          </>
        ) : null}
        <h3 className="mql-glab is-options">{t("chrome.quickLaunch.mobile.options")}</h3>
        <div className="mql-grp">
          <MobileEffortGateRow deck={deck} onToggle={toggleGate} />
          <button type="button" role="switch" aria-checked={props.ultracodeArmed} className="mql-gr is-two" onClick={() => props.onUltracode(!props.ultracodeArmed)}>
            <span className="mql-gr-tx">
              {t("chrome.quickLaunch.mobile.dynamic")}
              <small>{props.ultracodeArmed ? t("chrome.quickLaunch.ultracodeNotice") : t("chrome.quickLaunch.mobile.dynamicOff")}</small>
            </span>
            <Toggle on={props.ultracodeArmed} />
          </button>
        </div>
      </MobileSheet>
    );
  }

  if (sub === "attach") {
    return (
      <MobileSheet key="attach" title={t("chrome.quickLaunch.mobile.attach")} onClose={() => setSub(null)} className="mql-sheet">
        <button type="button" className="mobile-sheet-row" disabled={inApp} onClick={() => cameraRef.current?.click()}>
          <span className="mobile-sheet-row-glyph"><CameraIcon /></span>
          <span className="mobile-sheet-row-copy">{t("chrome.quickLaunch.mobile.takePhoto")}</span>
        </button>
        <button type="button" className="mobile-sheet-row" disabled={inApp} onClick={() => libraryRef.current?.click()}>
          <span className="mobile-sheet-row-glyph"><MobileIcon name="file" /></span>
          <span className="mobile-sheet-row-copy">{t("chrome.quickLaunch.mobile.pickPhoto")}</span>
        </button>
        {inApp ? <p className="mql-secnote">{t("chrome.quickLaunch.mobile.attachUnavailable")}</p> : null}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPickFiles} />
        <input ref={libraryRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
      </MobileSheet>
    );
  }

  const mentionRows: ReactNode[] = props.mentionDeckOpen ? [
    ...props.mentionEntries.map((entry) => {
      const selectable = isMentionSelectable(entry.activity);
      return (
        <button key={`op-${entry.operationId}`} type="button" className="mql-mention-row" disabled={!selectable} onClick={() => props.onPickMention({ kind: "operation", entry })}>
          <MobileMonogram label={entry.theaterLabel} toneKey={entry.theaterId ?? entry.theaterLabel} size={20} />
          <span className="mql-mention-name">{entry.operationName}</span>
        </button>
      );
    }),
    ...props.pluginMentionRows.map((row) => (
      <button key={`plugin-${row.optionId}`} type="button" className="mql-mention-row" onClick={() => props.onPickMention({ kind: "plugin", row })}>
        <span className="mql-mention-mark" aria-hidden="true">{row.renderMark?.() ?? "@"}</span>
        <span className="mql-mention-name">{row.label}<small>{row.categoryLabel}</small></span>
      </button>
    )),
  ] : [];

  return (
    // 시트마다 key가 다르다 — 같은 자리의 시트 인스턴스를 재사용하면 앞 시트의 닫히는 중 상태가 다음 시트에 남는다.
    <MobileSheet
      key="main"
      title={t("chrome.quickLaunch.mobile.title")}
      onClose={onClose}
      className="mql-sheet"
      footer={<button type="button" className="mobile-pill" disabled={!props.canSubmit} onClick={start}><MobileIcon name="send" size={18} />{t("chrome.quickLaunch.mobile.start")}</button>}
    >
      <div className="mql-compose">
        {mentionRows.length > 0 ? <div className="mql-mentions" role="listbox" aria-label={t("chrome.quickLaunch.mobile.inputLabel")}>{mentionRows}</div> : null}
        {props.mentionTarget ? (
          <button type="button" className="mobile-pill-secondary mql-mention-chip" aria-label={t("chrome.quickLaunch.mobile.mentionClear")} onClick={props.onClearMention}>
            @{mentionTargetName(props.mentionTarget)}<MobileIcon name="x" size={16} />
          </button>
        ) : null}
        <textarea
          ref={inputRef}
          className="mobile-field mql-input"
          value={prompt}
          placeholder={t("chrome.quickLaunch.mobile.placeholder")}
          aria-label={t("chrome.quickLaunch.mobile.inputLabel")}
          disabled={props.submitting}
          onChange={(event) => props.onPromptChange(event.target.value, event.currentTarget)}
        />
      </div>
      {props.attachments.length > 0 ? (
        <div className="mql-thumbs">
          {props.attachments.map((attachment) => (
            <button key={attachment.key} type="button" className={`mql-thumb${attachment.uploading ? " is-uploading" : ""}`} aria-label={t("chrome.quickLaunch.attachmentRemove", { name: attachment.name })} onClick={() => props.onRemoveAttachment(attachment.key)}>
              <img src={attachment.previewUrl} alt="" />
              <span className="mql-thumb-x"><MobileIcon name="x" size={14} /></span>
            </button>
          ))}
        </div>
      ) : null}
      {props.mentionTarget === null ? (
        <div className="mql-chips">
          <button type="button" className="mql-circ" data-press="r3" aria-label={t("chrome.quickLaunch.mobile.attach")} onClick={() => setSub("attach")}><MobileIcon name="plus" size={20} /></button>
          <button type="button" className="mobile-pill-secondary mql-theater-chip" aria-label={theater ? t("chrome.quickLaunch.mobile.theaterChip", { name: theater.label }) : t("chrome.quickLaunch.mobile.theater")} onClick={() => setSub("theater")} disabled={theaters.length === 0}>
            {theater ? <MobileMonogram label={theater.label} toneKey={theater.id} size={20} /> : null}
            <span className="mql-chip-name">{theater?.label ?? t("chrome.quickLaunch.mobile.theater")}</span>
          </button>
          <button type="button" className="mobile-pill-secondary mql-model-chip" onClick={() => setSub("model")} disabled={!selectedRow}>
            <span className="mql-chip-name">{selectedRow ? (groups.some((group) => isRosterFallbackGroup(group.id) && group.rows.includes(selectedRow)) ? `${selectedRow.label} · ${fallbackBadge}` : selectedRow.label) : t("chrome.quickLaunch.modelUnset")}</span>{selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? <span className="mql-chip-effort">{effortLabel}</span> : null}
          </button>
        </div>
      ) : null}
      {props.message ? <p className="mql-message" role="alert">{props.message}</p> : <p className="mql-secnote">{t("chrome.quickLaunch.mobile.defaults")}</p>}
    </MobileSheet>
  );
}
