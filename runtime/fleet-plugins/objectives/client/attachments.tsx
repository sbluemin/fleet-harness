import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AttachImageIcon } from "@fleet-console/sdk/composer";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { ObjectiveAttachment, Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 브리핑 첨부 — 붙이는 입구는 브리핑 머리의 첨부 글리프 하나다(채팅 컴포저와 같은 그림). 형식·크기 안내는 그 글리프의 말풍선이 진다.
 * 이미지가 있을 때만 본문 위에 번호 배지 썸네일 띠가 선다 — 빈 브리핑에 초점이 와도 자리를 밀지 않는다.
 * 메모에 붙여넣거나 구획에 끌어오면 여기로 들어오고, 누르면 크게 보고, × 로 지운다. 이미지는 id 로 받아 온다 — 경로는 브라우저에 오지 않는다.
 */

const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ACCEPT = [...TYPES].join(",");
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_COUNT = 20;
type T = Translate<ObjectiveMessageKey>;

const fileUrl = (objective: Pick<Objective, "id">, attachment: Pick<ObjectiveAttachment, "id">) => `/plugins/objectives/attachment/file?objectiveId=${encodeURIComponent(objective.id)}&attachmentId=${encodeURIComponent(attachment.id)}`;

/** 클립보드·끌어놓기에서 이미지 파일만 고른다. */
export function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
}

/** 올리기 — 형식·크기·개수를 먼저 보고 하나씩 보낸다. 항목 갱신은 응답이 아니라 `objectives:objective` 사건으로 들어온다. */
export function useAttachmentUpload(objective: Objective, t: T) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(0);
  const upload = useCallback(async (files: readonly File[]) => {
    setError(null);
    let room = MAX_COUNT - (objective.attachments?.length ?? 0);
    for (const file of files) {
      if (!TYPES.has(file.type)) { setError(t("objectives.att.errType", { name: file.name })); continue; }
      if (file.size > MAX_BYTES) { setError(t("objectives.att.errSize", { name: file.name })); continue; }
      if (room <= 0) { setError(t("objectives.att.errCount")); break; }
      room -= 1;
      setSending((value) => value + 1);
      try {
        const response = await fetch(`/plugins/objectives/attachment/add?objectiveId=${encodeURIComponent(objective.id)}&name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!response.ok) {
          const code = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `http_${response.status}`;
          setError(code === "attachment_type" ? t("objectives.att.errType", { name: file.name }) : code === "attachment_too_large" ? t("objectives.att.errSize", { name: file.name }) : code === "too_many_attachments" ? t("objectives.att.errCount") : t("objectives.att.errFailed", { name: file.name, code }));
        }
      } catch { setError(t("objectives.att.errFailed", { name: file.name, code: "network" })); }
      finally { setSending((value) => value - 1); }
    }
  }, [objective.attachments?.length, objective.id, t]);
  return { upload, error, sending };
}

const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

/**
 * 브리핑 머리의 첨부 글리프 — 파일 픽커 입구. 이름은 aria-label 에, 형식·크기 안내는 hover·focus 로 여닫는 말풍선에 싣는다
 * (Scuttlebutt 머리 조작·설정 도움말과 같은 계약). 말풍선은 문서 끝으로 포털한다 — 패널이 backdrop-filter 를 지면 안의 말풍선은 흐려 보인다.
 */
export function AttachButton({ objective, t, upload, sending }: {
  readonly objective: Objective;
  readonly t: T;
  readonly upload: (files: readonly File[]) => Promise<void>;
  readonly sending: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ readonly top: number; readonly right: number } | null>(null);
  const full = (objective.attachments?.length ?? 0) >= MAX_COUNT;
  const label = t("objectives.att.addAria");
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);
  return (
    <span className="objectives-att-slot" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={buttonRef} type="button" className="objectives-att-add" aria-label={label} aria-describedby={tipId} disabled={sending > 0 || full}
        onClick={() => { setOpen(false); inputRef.current?.click(); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        {sending > 0 ? <i className="objectives-att-spin" aria-hidden="true" /> : <AttachImageIcon />}
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple hidden onChange={(event) => { const files = imageFiles(event.target.files); event.target.value = ""; if (files.length) void upload(files); }} />
      {createPortal(
        <span className="objectives-att-tip" role="tooltip" id={tipId} hidden={!open || anchor === null} style={anchor ? { top: anchor.top, right: anchor.right } : undefined}>
          <b>{label}</b>
          {full ? t("objectives.att.errCount") : t("objectives.att.hint")}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** 끌어놓는 동안 브리핑 구획 위에 겹치는 판 — 자리를 밀지 않는다. */
export function AttachmentDropVeil({ t }: { readonly t: T }) {
  return <div className="objectives-att-drop" aria-hidden="true"><span><AttachImageIcon />{t("objectives.att.drop")}</span></div>;
}

export function NoteAttachments({ objective, t, touchable, error, sending, onRemove }: {
  readonly objective: Objective;
  readonly t: T;
  readonly touchable: boolean;
  readonly error: string | null;
  readonly sending: number;
  readonly onRemove: (attachment: ObjectiveAttachment) => void;
}) {
  const [open, setOpen] = useState<ObjectiveAttachment | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const attachments = objective.attachments ?? [];
  const label = (attachment: ObjectiveAttachment) => t("objectives.att.label", { n: attachment.n });
  if (attachments.length === 0 && sending === 0 && !error) return null;
  return (
    <div className="objectives-att">
      {attachments.length > 0 || sending > 0 ? (
        <div className="objectives-att-strip">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="objectives-att-thumb">
              <button type="button" className="objectives-att-open" aria-label={t("objectives.att.open", { label: label(attachment), name: attachment.name })} title={`${label(attachment)} · ${attachment.name}`} onClick={(event) => { openerRef.current = event.currentTarget; setOpen(attachment); }}>
                <img src={fileUrl(objective, attachment)} alt="" loading="lazy" draggable={false} />
              </button>
              <span className="objectives-att-n" aria-hidden="true">{attachment.n}</span>
              {touchable ? <button type="button" className="objectives-att-x" aria-label={t("objectives.att.remove", { label: label(attachment) })} title={t("objectives.att.remove", { label: label(attachment) })} onClick={() => onRemove(attachment)}><CloseGlyph /></button> : null}
            </div>
          ))}
          {Array.from({ length: sending }, (_, index) => (
            <div key={`sending-${index}`} className="objectives-att-thumb is-sending">
              <span className="objectives-att-open" role="status" aria-label={t("objectives.att.sending")}><i className="objectives-att-spin" aria-hidden="true" /></span>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="objectives-att-err" role="alert">{error}</div> : null}
      {open ? createPortal(<AttachmentView t={t} src={fileUrl(objective, open)} caption={`${label(open)} · ${open.name}${open.width && open.height ? ` · ${open.width}×${open.height}` : ""}`} onClose={() => { setOpen(null); openerRef.current?.focus(); }} />, document.body) : null}
    </div>
  );
}

/** 크게 보기 — body 포털의 고정 오버레이, 채팅 첨부 보기와 같은 틀. Esc·바깥 누름·닫기 글리프로 닫힌다(Esc 는 상세가 함께 닫히지 않게 캡처에서 삼킨다). */
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
        <button ref={closeRef} type="button" className="objectives-att-view-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        <img src={src} alt={caption} />
        <figcaption>{caption}</figcaption>
      </figure>
    </div>
  );
}
