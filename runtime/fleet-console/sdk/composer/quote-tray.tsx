import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import type { Translate } from "../i18n/types.js";
import type { ComposerMessageKey } from "./messages.js";
import type { ComposerQuote, ComposerQuoteItem, ComposerQuoteKind, ComposerQuotes } from "./quotes.js";
import { COMPOSER_QUOTE_MAX_NOTE } from "./quotes.js";

/**
 * 인용 칩 — 입력창 캡슐 맨 위의 붙인 인용 줄과, 보낸 말풍선의 같은 칩.
 *
 * 외형은 첨부 줄과 한 벌이라 클래스(`fc-composer-quote*`)를 고정하고 호스트가 그린다(core `components.css`). 칩을 누르면 그 인용에만
 * 붙일 한 줄과 종류(댓글/질문)를 고치는 작은 편집기가 칩 위에 선다. 상태는 조립(초안)이 가진다.
 */

function QuoteGlyph({ kind }: { readonly kind: ComposerQuoteKind }) {
  return kind === "question"
    ? <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" /><path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.4M8 11.3v.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
    : <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function useComposerQuotes(store: ComposerQuotes): readonly ComposerQuoteItem[] {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

/** 인용이 붙은 입력창의 빈 칸 안내. 인용이 없으면 null — 조립의 원래 안내를 쓴다. */
export function composerQuotePlaceholder(count: number, t: Translate<ComposerMessageKey>): string | null {
  if (count <= 0) return null;
  return count === 1 ? t("composer.quote.placeholderOne") : t("composer.quote.placeholder", { count: String(count) });
}

export interface ComposerQuoteTrayProps {
  readonly store: ComposerQuotes;
  readonly t: Translate<ComposerMessageKey>;
  readonly disabled?: boolean;
  /** 편집기를 닫은 뒤 초점을 돌려줄 곳(보통 입력칸). */
  readonly onDone?: () => void;
}

export function ComposerQuoteTray({ store, t, disabled = false, onDone }: ComposerQuoteTrayProps) {
  const items = useComposerQuotes(store);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { if (editing && !items.some((item) => item.key === editing)) setEditing(null); }, [items, editing]);
  if (items.length === 0) return null;
  return (
    <div className="fc-composer-quotes" role="group" aria-label={t("composer.quote.list")}>
      {items.map((item) => (
        <QuoteChip
          key={item.key}
          item={item}
          t={t}
          disabled={disabled}
          editing={editing === item.key}
          onEdit={(open) => setEditing(open ? item.key : null)}
          onSave={(patch) => { store.update(item.key, patch); setEditing(null); onDone?.(); }}
          onRemove={() => { store.remove(item.key); onDone?.(); }}
        />
      ))}
    </div>
  );
}

function QuoteChip({ item, t, disabled, editing, onEdit, onSave, onRemove }: {
  readonly item: ComposerQuoteItem;
  readonly t: Translate<ComposerMessageKey>;
  readonly disabled: boolean;
  readonly editing: boolean;
  readonly onEdit: (open: boolean) => void;
  readonly onSave: (patch: { readonly note: string; readonly kind: ComposerQuoteKind }) => void;
  readonly onRemove: () => void;
}) {
  const openRef = useRef<HTMLButtonElement | null>(null);
  const excerpt = clip(item.excerpt, 48);
  return (
    <span className={`fc-composer-quote is-${item.kind}`} title={t("composer.quote.from", { source: item.source.label })}>
      <span className="fc-composer-quote__kind" aria-label={t(item.kind === "question" ? "composer.quote.question" : "composer.quote.comment")} role="img"><QuoteGlyph kind={item.kind} /></span>
      <button
        ref={openRef}
        type="button"
        className="fc-composer-quote__open"
        disabled={disabled}
        aria-expanded={editing}
        aria-label={t("composer.quote.edit", { excerpt })}
        onClick={() => onEdit(!editing)}
      >
        <span className="fc-composer-quote__excerpt">{excerpt}</span>
        {item.note ? <span className="fc-composer-quote__note">{item.note}</span> : null}
      </button>
      <button type="button" className="fc-composer-quote__remove" disabled={disabled} aria-label={t("composer.quote.remove", { excerpt })} title={t("composer.quote.remove", { excerpt })} onClick={onRemove}>×</button>
      {editing ? <QuoteEditor item={item} t={t} onSave={onSave} onClose={() => { onEdit(false); openRef.current?.focus(); }} /> : null}
    </span>
  );
}

function QuoteEditor({ item, t, onSave, onClose }: {
  readonly item: ComposerQuoteItem;
  readonly t: Translate<ComposerMessageKey>;
  readonly onSave: (patch: { readonly note: string; readonly kind: ComposerQuoteKind }) => void;
  readonly onClose: () => void;
}) {
  const [note, setNote] = useState(item.note ?? "");
  const [kind, setKind] = useState<ComposerQuoteKind>(item.kind);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  useEffect(() => { fieldRef.current?.focus(); }, []);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || rootRef.current?.parentElement?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", pointer);
    return () => document.removeEventListener("pointerdown", pointer);
  }, [onClose]);
  const save = () => onSave({ note, kind });
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  return (
    <div ref={rootRef} className="fc-composer-quote-editor" role="dialog" aria-label={t("composer.quote.edit", { excerpt: clip(item.excerpt, 48) })}>
      <span className="fc-composer-quote-editor__excerpt">{clip(item.excerpt, 120)}</span>
      <div className="fc-composer-quote-editor__kinds" role="group" aria-label={t("composer.quote.kind")}>
        {(["comment", "question"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{t(value === "question" ? "composer.quote.question" : "composer.quote.comment")}</button>
        ))}
      </div>
      <textarea
        ref={fieldRef}
        className="fc-composer-quote-editor__field"
        rows={2}
        maxLength={COMPOSER_QUOTE_MAX_NOTE}
        value={note}
        placeholder={t("composer.quote.notePlaceholder")}
        aria-label={t("composer.quote.notePlaceholder")}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      />
      <div className="fc-composer-quote-editor__row">
        <span>{t("composer.quote.editorHint")}</span>
        <button type="button" className="fc-composer-quote-editor__save" onClick={save}>{t("composer.quote.save")}</button>
      </div>
    </div>
  );
}

/** 보낸 말풍선의 인용 칩 — 고칠 수 없는 같은 칩이다. */
export function ComposerQuoteList({ quotes, t }: { readonly quotes: readonly ComposerQuote[]; readonly t: Translate<ComposerMessageKey> }) {
  if (quotes.length === 0) return null;
  return (
    <span className="fc-composer-quotes is-sent" role="group" aria-label={t("composer.quote.list")}>
      {quotes.map((quote, index) => (
        <span key={index} className={`fc-composer-quote is-${quote.kind} is-sent`} title={t("composer.quote.from", { source: quote.source.label })}>
          <span className="fc-composer-quote__kind" aria-label={t(quote.kind === "question" ? "composer.quote.question" : "composer.quote.comment")} role="img"><QuoteGlyph kind={quote.kind} /></span>
          <span className="fc-composer-quote__body">
            <span className="fc-composer-quote__excerpt">{clip(quote.excerpt, 64)}</span>
            {quote.note ? <span className="fc-composer-quote__note">{quote.note}</span> : null}
          </span>
        </span>
      ))}
    </span>
  );
}
