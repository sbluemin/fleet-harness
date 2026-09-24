import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { ObjectiveAttachment, ObjectiveItem } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 메모 첨부 띠 — 메모 본문 위에 붙인 순서대로 「이미지 n」 썸네일이 선다.
 * 메모에 붙여넣거나 끌어오면 여기로 들어오고, 누르면 크게 보고, × 로 지운다. 이미지는 id 로 받아 온다 — 경로는 브라우저에 오지 않는다.
 */

const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_COUNT = 20;
type T = Translate<ObjectiveMessageKey>;

const fileUrl = (item: Pick<ObjectiveItem, "id">, attachment: Pick<ObjectiveAttachment, "id">) => `/plugins/objectives/attachment/file?itemId=${encodeURIComponent(item.id)}&attachmentId=${encodeURIComponent(attachment.id)}`;

/** 클립보드·끌어놓기에서 이미지 파일만 고른다. */
export function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
}

/** 올리기 — 형식·크기·개수를 먼저 보고 하나씩 보낸다. 항목 갱신은 응답이 아니라 `objectives:item` 사건으로 들어온다. */
export function useAttachmentUpload(item: ObjectiveItem, t: T) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(0);
  const upload = useCallback(async (files: readonly File[]) => {
    setError(null);
    let room = MAX_COUNT - (item.attachments?.length ?? 0);
    for (const file of files) {
      if (!TYPES.has(file.type)) { setError(t("objectives.att.errType", { name: file.name })); continue; }
      if (file.size > MAX_BYTES) { setError(t("objectives.att.errSize", { name: file.name })); continue; }
      if (room <= 0) { setError(t("objectives.att.errCount")); break; }
      room -= 1;
      setSending((value) => value + 1);
      try {
        const response = await fetch(`/plugins/objectives/attachment/add?itemId=${encodeURIComponent(item.id)}&name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!response.ok) {
          const code = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `http_${response.status}`;
          setError(code === "attachment_type" ? t("objectives.att.errType", { name: file.name }) : code === "attachment_too_large" ? t("objectives.att.errSize", { name: file.name }) : code === "too_many_attachments" ? t("objectives.att.errCount") : t("objectives.att.errFailed", { name: file.name, code }));
        }
      } catch { setError(t("objectives.att.errFailed", { name: file.name, code: "network" })); }
      finally { setSending((value) => value - 1); }
    }
  }, [item.attachments?.length, item.id, t]);
  return { upload, error, sending };
}

const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

export function NoteAttachments({ item, t, touchable, upload, error, sending, onRemove }: {
  readonly item: ObjectiveItem;
  readonly t: T;
  readonly touchable: boolean;
  readonly upload: (files: readonly File[]) => Promise<void>;
  readonly error: string | null;
  readonly sending: number;
  readonly onRemove: (attachment: ObjectiveAttachment) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState<ObjectiveAttachment | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const attachments = item.attachments ?? [];
  const label = (attachment: ObjectiveAttachment) => t("objectives.att.label", { n: attachment.n });
  if (!touchable && attachments.length === 0) return null;
  return (
    <div className="objectives-att">
      <div className="objectives-att-strip">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="objectives-att-thumb">
            <button type="button" className="objectives-att-open" aria-label={t("objectives.att.open", { label: label(attachment), name: attachment.name })} title={attachment.name} onClick={(event) => { openerRef.current = event.currentTarget; setOpen(attachment); }}>
              <img src={fileUrl(item, attachment)} alt="" loading="lazy" draggable={false} />
            </button>
            <span className="objectives-att-label">{label(attachment)}</span>
            {touchable ? <button type="button" className="objectives-att-x" aria-label={t("objectives.att.remove", { label: label(attachment) })} title={t("objectives.att.remove", { label: label(attachment) })} onClick={() => onRemove(attachment)}><CloseGlyph /></button> : null}
          </div>
        ))}
        {touchable && attachments.length < MAX_COUNT ? (
          <button type="button" className="objectives-att-add" aria-label={t("objectives.att.addAria")} onClick={() => inputRef.current?.click()} disabled={sending > 0}>
            {sending > 0 ? <i className="objectives-att-spin" aria-hidden="true" /> : t("objectives.att.add")}
          </button>
        ) : null}
      </div>
      {touchable ? <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => { const files = imageFiles(event.target.files); event.target.value = ""; if (files.length) void upload(files); }} /> : null}
      {touchable && attachments.length === 0 ? <div className="objectives-att-hint">{t("objectives.att.hint")}</div> : null}
      {error ? <div className="objectives-att-err" role="alert">{error}</div> : null}
      {open ? createPortal(<AttachmentView t={t} src={fileUrl(item, open)} caption={`${label(open)} · ${open.name}${open.width && open.height ? ` · ${open.width}×${open.height}` : ""}`} onClose={() => { setOpen(null); openerRef.current?.focus(); }} />, document.body) : null}
    </div>
  );
}

/** 크게 보기 — body 포털의 고정 오버레이. Esc·바깥 누름·닫기 글리프로 닫힌다(Esc 는 상세가 함께 닫히지 않게 캡처에서 삼킨다). */
function AttachmentView({ t, src, caption, onClose }: { readonly t: T; readonly src: string; readonly caption: string; readonly onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      // 초점은 닫기 글리프 하나에 머문다 — 뒤의 패널로 새지 않게.
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="objectives-zoom-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <figure className="objectives-att-view" role="dialog" aria-modal="true" aria-label={caption}>
        <button ref={closeRef} type="button" className="objectives-glyph objectives-att-view-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        <img src={src} alt={caption} />
        <figcaption>{caption}</figcaption>
      </figure>
    </div>
  );
}
