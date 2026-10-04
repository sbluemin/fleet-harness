import { useEffect, useRef, useState, type ChangeEvent, type MutableRefObject, type ReactNode } from "react";

import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { isFleetMobileShell } from "@fleet-console/link/core";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationSearchEntry } from "../../../../core/client/src/integration/operation-search.js";
import { MobileIcon } from "../../../../core/client/src/chrome/mobile/mobile-icons.js";
import { MobileMonogram } from "../../../../core/client/src/chrome/mobile/mobile-monogram.js";
import { MobileSheet } from "../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushOverlayHistory, releaseOverlayHistory, runAfterOverlayRelease } from "../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { buildQuickLaunchEffortDeck, isMentionSelectable, mentionTargetName, type QuickLaunchMentionTarget, type QuickLaunchPluginMentionRow } from "../quick-launch.js";
import type { QuickLaunchStartView } from "../quick-launch-preferences.js";
import "./mobile-quick-launch.css";

/**
 * 모바일 「새 작업」 시트(S-11a~e). 상태·효과·제출은 데스크톱 Quick Launch 컴포넌트가 그대로 소유하고, 이 화면은
 * 그 값과 콜백을 받아 모바일 문법으로만 그린다 — 로직 사본이 없다. 하네스 칩은 현행 모델 그룹(제공자), 모델 시트는
 * 그 그룹의 모델과 강도 글자 탭, 옵션 묶음은 게이트 펼치기 · 채팅뷰로 시작 · 다이나믹 워크플로우다(D20·D41).
 */

type Sub = "theater" | "model" | "harness" | "attach";

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
  readonly chatStartAvailable: boolean;
  readonly chatStart: boolean;
  readonly onStartView: (view: QuickLaunchStartView) => void;
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

export function MobileQuickLaunch(props: MobileQuickLaunchProps) {
  const t = useT();
  const { inputRef, prompt, theaters, theaterId, groups, selectedRow, effort, onSubmit, onClose } = props;
  const [sub, setSub] = useState<Sub | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const inApp = isFleetMobileShell();

  // 하드웨어·브라우저 뒤로는 화면을 떠나지 않고 시트를 닫는다 — 시트 한 겹마다 history 항목 하나(셸 시트와 같은 계약).
  const sheetHistoryRef = useRef<number | null>(null);
  useEffect(() => {
    const id = pushOverlayHistory(() => { sheetHistoryRef.current = null; onClose(); });
    sheetHistoryRef.current = id;
    return () => { if (sheetHistoryRef.current !== null) releaseOverlayHistory(sheetHistoryRef.current); sheetHistoryRef.current = null; };
    // 열려 있는 동안 한 번 — 닫기 콜백은 store 동작이라 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (sub === null) return;
    let id: number | null = pushOverlayHistory(() => { id = null; setSub(null); });
    return () => { if (id !== null) releaseOverlayHistory(id); };
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
  const group = selectedRow ? groups.find((candidate) => candidate.rows.some((row) => row.id === selectedRow.id)) ?? null : null;
  const autoLabel = t("launchVariants.effort.auto");
  const deck = buildQuickLaunchEffortDeck(selectedRow, effort, autoLabel, "", gateOpen);
  const effortLabel = deck.options.find((option) => option.checked)?.label ?? autoLabel;
  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setSub(null);
    if (files.length > 0) props.onAddFiles(files);
  };

  // 게이트 펼치기를 끄면 게이트 단은 숨는다 — 그 단을 고른 상태였으면 바로 아래 일상 단으로 되돌린다(S-11e ①).
  const toggleGate = () => {
    if (!deck.gateOpen) { setGateOpen(true); return; }
    if (deck.gateHeldByValue && selectedRow) {
      const gated = new Set(selectedRow.gatedEfforts ?? []);
      const everyday = (selectedRow.chips ?? []).filter((chip) => !gated.has(chip.id));
      props.onEffort(everyday.at(-1)?.id ?? null);
    }
    setGateOpen(false);
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
        <div className="mql-grp">
          {(group?.rows ?? []).map((row) => (
            <button key={row.id} type="button" role="radio" aria-checked={row.id === selectedRow?.id} className="mql-gr" onClick={() => props.onModelRow(row)}>
              <Radio on={row.id === selectedRow?.id} /><span className="mql-gr-tx">{row.label}</span>
            </button>
          ))}
        </div>
        {selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? (
          <>
            <h3 className="mql-glab">{t("chrome.quickLaunch.mobile.effort")}</h3>
            <div className="mql-efft" role="radiogroup" aria-label={t("chrome.quickLaunch.mobile.effort")}>
              {deck.options.map((option) => (
                <button key={option.id ?? "auto"} type="button" role="radio" aria-checked={option.checked} className={option.checked ? "is-on" : ""} onClick={() => props.onEffort(option.id)}>{option.label}</button>
              ))}
            </div>
          </>
        ) : null}
        <h3 className="mql-glab is-options">{t("chrome.quickLaunch.mobile.options")}</h3>
        <div className="mql-grp">
          {deck.hasGate ? (
            <button type="button" role="switch" aria-checked={deck.gateOpen} className="mql-gr" onClick={toggleGate}>
              <span className="mql-gr-tx">{t("launchVariants.effort.apexToggle", { tiers: deck.gatedNames })}</span>
              <Toggle on={deck.gateOpen} />
            </button>
          ) : null}
          {props.chatStartAvailable ? (
            <button type="button" role="switch" aria-checked={props.chatStart} className="mql-gr is-two" onClick={() => props.onStartView(props.chatStart ? "terminal" : "chat")}>
              <span className="mql-gr-tx">
                {t("chrome.quickLaunch.mobile.chatStart")}
                <small>{props.chatStart ? t("chrome.quickLaunch.startViewChatHint") : `${t("chrome.quickLaunch.startViewTerminal")} · ${t("chrome.quickLaunch.startViewTerminalHint")}`}</small>
              </span>
              <Toggle on={props.chatStart} />
            </button>
          ) : null}
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

  if (sub === "harness") {
    return (
      <MobileSheet key="harness" title={t("chrome.quickLaunch.mobile.harness")} onClose={() => setSub(null)} className="mql-sheet">
        <div className="mql-grp">
          {groups.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === group?.id}
              className="mql-gr"
              onClick={() => {
                // 하네스를 바꾸면 그 그룹의 첫 모델로 선다 — 같은 그룹이면 고른 모델을 지킨다.
                const row = candidate.id === group?.id ? selectedRow : candidate.rows[0] ?? null;
                if (row && row.id !== selectedRow?.id) props.onModelRow(row);
                setSub(null);
              }}
            >
              <Radio on={candidate.id === group?.id} /><span className="mql-gr-tx">{candidate.label}</span>
            </button>
          ))}
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
          <button type="button" className="mobile-pill-secondary" onClick={() => setSub("theater")} disabled={theaters.length === 0}>
            {theater ? <MobileMonogram label={theater.label} toneKey={theater.id} size={20} /> : null}
            {theater?.label ?? t("chrome.quickLaunch.mobile.theater")}
          </button>
          <button type="button" className="mobile-pill-secondary" onClick={() => setSub("model")} disabled={!selectedRow}>
            {selectedRow?.label ?? t("chrome.quickLaunch.modelUnset")}{selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? <span className="mql-chip-effort">{effortLabel}</span> : null}
          </button>
          <button type="button" className="mobile-pill-secondary" onClick={() => setSub("harness")} disabled={groups.length === 0}>{group?.label ?? t("chrome.quickLaunch.mobile.harness")}</button>
          <button type="button" className="mobile-pill-secondary" onClick={() => setSub("attach")}><MobileIcon name="plus" size={18} />{t("chrome.quickLaunch.mobile.attach")}</button>
        </div>
      ) : null}
      {props.message ? <p className="mql-message" role="alert">{props.message}</p> : <p className="mql-secnote">{t("chrome.quickLaunch.mobile.defaults")}</p>}
    </MobileSheet>
  );
}
