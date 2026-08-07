import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { installCodeCopyHandler, renderMarkdown } from "@fleet-console/markdown/core";
import "@fleet-console/markdown/styles.css";

import "../styles/developer-notes.css";
import {
  countUnreadDeveloperNotes,
  isDeveloperNoteEdited,
  isDeveloperNoteRead,
  pruneDeveloperNoteSeen,
  withDeveloperNoteRead,
} from "../developer-notes-read.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { closeDeveloperNotes, selectDeveloperNote } from "../store.js";
import type { ConsoleState, DeveloperNote } from "../types.js";

interface DeveloperNotesSheetProps {
  readonly state: ConsoleState;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function DeveloperNotesSheet({ state }: DeveloperNotesSheetProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const globalSettings = useGlobalSettingsStore();
  const seen = globalSettings.state?.seenDeveloperNotes ?? [];
  const notes = state.developerNotes;
  const selected = notes.find((note) => note.id === state.selectedDeveloperNoteId) ?? notes[0];

  const rendered = useMemo(
    () => (selected === undefined
      ? { html: "" }
      : renderMarkdown(selected.body, {
        omitDuplicateTitle: selected.title,
        untrustedRemoteBody: true,
        blockedImageLabel: t("chrome.developerNotes.imageOmitted"),
        copyLabel: t("chrome.developerNotes.copy"),
      })),
    [selected, t],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    const shell = document.querySelector<HTMLElement>(".console-shell");
    if (shell) shell.inert = true;
    dialog?.focus();
    return () => {
      if (shell) shell.inert = false;
    };
  }, []);

  // 렌더된 코드블록의 Copy 버튼은 마크다운 렌더러가 만든다 — 붙이는 표면이 동작을 설치하지
  // 않으면 보이는 컨트롤이 아무 일도 하지 않는다.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    return installCodeCopyHandler(body, { copiedLabel: t("chrome.developerNotes.copied") });
  }, [rendered, t]);

  // 열릴 때 선택된 노트를 읽음으로 올리고, 철회된 노트의 표식을 함께 정리한다.
  useEffect(() => {
    if (selected === undefined) return;
    const pruned = pruneDeveloperNoteSeen(seen, notes);
    const next = withDeveloperNoteRead(pruned, selected);
    if (next === seen) return;
    void setGlobalSettingsField("seenDeveloperNotes", next);
  }, [notes, seen, selected]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeveloperNotes();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (activeElement === dialogRef.current || !dialogRef.current?.contains(activeElement) || (event.shiftKey ? activeElement === first : activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };

  return createPortal(
    <div className="developer-notes-scrim" onMouseDown={closeDeveloperNotes}>
      <div
        ref={dialogRef}
        className="developer-notes-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("chrome.developerNotes.title")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="developer-notes-head">
          <strong>{t("chrome.developerNotes.title")}</strong>
          <button type="button" onClick={closeDeveloperNotes} aria-label={t("chrome.developerNotes.closeAria")}>✕</button>
        </div>
        <div className="developer-notes-layout">
          <nav className="developer-notes-list" aria-label={t("chrome.developerNotes.listAria")}>
            {notes.map((note) => (
              <button
                key={note.id}
                type="button"
                className="developer-notes-item"
                aria-current={note.id === selected?.id}
                onClick={() => selectDeveloperNote(note.id)}
              >
                <span className="developer-notes-item-title">
                  {isDeveloperNoteRead(seen, note) ? null : <span className="developer-notes-unread" aria-hidden="true" />}
                  {note.title}
                  {isDeveloperNoteEdited(seen, note) ? <span className="developer-notes-edited">{t("chrome.developerNotes.edited")}</span> : null}
                </span>
                <time dateTime={note.publishedAt}>{formatPublishedAt(note.publishedAt)}</time>
              </button>
            ))}
          </nav>
          <article className="developer-notes-body">
            {selected === undefined
              ? <p className="developer-notes-empty">{t("chrome.developerNotes.empty")}</p>
              : <>
                <h2>{selected.title}</h2>
                {/* renderMarkdown은 DOMPurify를 두 번 통과시킨 문자열만 돌려주고, 원격 저작 본문이므로
                    이미지 제거와 절대 https 링크 제한을 함께 건다(untrustedRemoteBody). */}
                <div ref={bodyRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
                <a className="developer-notes-source" href={selected.url} target="_blank" rel="noopener noreferrer">
                  {t("chrome.developerNotes.openOnGithub")}
                </a>
              </>}
          </article>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function developerNotesUnreadCount(seen: readonly string[], notes: readonly DeveloperNote[]): number {
  return countUnreadDeveloperNotes(seen, notes);
}

function formatPublishedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}
