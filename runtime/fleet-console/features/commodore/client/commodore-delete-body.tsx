import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CommodoreDeletePreview } from "../shared/contracts/deletion.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { commodoreSectionLabel, readCommodoreList, refreshCommodoreList } from "./commodore-list.js";
import { holdCommodoreDeletion, subscribeCommodoreLifecycle, type CommodoreDeletionNotice } from "./commodore-delete-events.js";
import { deleteCommodore, previewCommodoreDeletion } from "./theaters-api.js";
import { getT } from "./i18n/index.js";
import { forgetCommodoreClient } from "./commodore-state.js";

type T = ReturnType<typeof getT>;
export interface CommodoreDeleteFrame {
  readonly title: string;
  readonly closeLabel: string;
  readonly questionId: string;
  readonly step: 1 | 2;
  readonly busy: boolean;
  readonly body: ReactNode;
  readonly footer: ReactNode;
  readonly close: () => void;
  readonly back: () => void;
}

/** 같은 확인 상태를 데스크톱 대화상자와 폰 시트에 싣는다. 프레임·history는 호스트가 가진다. */
export function CommodoreDeleteFlow({ commodoreId, language, mobile = false, onClose, onComplete, renderFrame, onBackHandler }: {
  readonly commodoreId: string;
  readonly language: "en" | "ko";
  readonly mobile?: boolean;
  readonly onClose: () => void;
  readonly onComplete: (notice: CommodoreDeletionNotice) => void;
  readonly renderFrame: (frame: CommodoreDeleteFrame) => ReactNode;
  readonly onBackHandler?: (back: () => void) => void;
}) {
  const t = getT(language);
  const questionId = useId(), promptId = useId();
  const [initial] = useState(() => {
    const rows = readCommodoreList(), index = rows.findIndex((row) => row.commodoreId === commodoreId);
    return { row: rows[index], focusId: rows[index + 1]?.commodoreId ?? rows[index - 1]?.commodoreId ?? null };
  });
  const [preview, setPreview] = useState<{ data: CommodoreDeletePreview; language: "en" | "ko" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<"failed" | "renamed" | "inProgress" | null>(null);
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null), next = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const busyRef = useRef(false), gone = useRef(false), finished = useRef(false), mounted = useRef(true);
  const completeRef = useRef(onComplete); completeRef.current = onComplete;
  const name = preview?.data.confirmationAlias ?? (initial.row ? commodoreSectionLabel(initial.row, t("commodore.name")) : t("commodore.name"));
  const nameRef = useRef(name); nameRef.current = name;
  const normalize = (text: string) => text.trim().normalize("NFC");
  const matched = !!preview && !loading && !loadFailed && !composing && normalize(value) === normalize(preview.data.confirmationAlias);
  const finish = useCallback((alreadyGone: boolean, warnings: readonly string[] = []) => {
    if (finished.current || !mounted.current) return;
    finished.current = true;
    forgetCommodoreClient(commodoreId);
    void refreshCommodoreList();
    completeRef.current({ commodoreId, focusId: initial.focusId,
      message: alreadyGone ? t("commodore.delete.alreadyGone") : t("commodore.delete.done", { name: nameRef.current }),
      ...(warnings.length ? { warning: t("commodore.delete.partial") } : {}),
    });
  }, [commodoreId, initial.focusId, t]);
  const fetchPreview = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setLoadFailed(false);
    try {
      const data = await previewCommodoreDeletion({ commodoreId, language }, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setPreview({ data, language }); setBlocked(false);
    } catch (failure) {
      if (controller.signal.aborted || !mounted.current) return;
      const code = failure instanceof Error ? failure.message : "";
      if (code === "unknown_commodore") { finish(true); return; }
      if (code === "commodore_deleting") { setBlocked(true); setError("inProgress"); }
      setLoadFailed(true);
    } finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, [commodoreId, language, finish]);
  useEffect(() => {
    mounted.current = true;
    const release = holdCommodoreDeletion(commodoreId);
    return () => { mounted.current = false; request.current?.abort(); release(); };
  }, [commodoreId]);
  useEffect(() => { void fetchPreview(); }, [fetchPreview]);
  useEffect(() => subscribeCommodoreLifecycle((event) => {
    if (event.commodoreId !== commodoreId) return;
    if (event.op === "removed") { gone.current = true; if (!busyRef.current) finish(true); }
    else if (event.op === "state" && event.change === "alias" && !busyRef.current) void fetchPreview();
  }), [commodoreId, finish, fetchPreview]);
  useLayoutEffect(() => {
    if (step === 2) input.current?.focus({ preventScroll: true });
    else if (!mobile) cancel.current?.focus({ preventScroll: true });
  }, [step, mobile]);

  const close = () => { if (!busyRef.current) onClose(); };
  const back = () => {
    if (busyRef.current) return;
    if (step === 1) { close(); return; }
    setStep(1); setValue(""); setError(null); setComposing(false);
    requestAnimationFrame(() => next.current?.focus({ preventScroll: true }));
  };
  useLayoutEffect(() => { onBackHandler?.(back); });
  const submit = async () => {
    if (!matched || busyRef.current || blocked || !preview) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await deleteCommodore({ commodoreId, language: preview.language, confirm: true, alias: preview.data.confirmationAlias });
      finish(false, result.warnings);
    } catch (failure) {
      if (!mounted.current) return;
      const code = failure instanceof Error ? failure.message : "";
      if (gone.current || code === "unknown_commodore") { finish(true); return; }
      if (code === "commodore_deleting") { setBlocked(true); setError("inProgress"); }
      else if (code === "confirmation_mismatch") {
        setValue(""); setError("renamed"); await fetchPreview();
        requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
      } else setError("failed");
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const buttonClass = mobile ? "mobile-pill-secondary" : "fc-btn fc-btn--secondary commodore-create-button";
  const footer = step === 1 ? <>
    <button ref={cancel} type="button" className={buttonClass} onClick={close}>{t("commodore.delete.cancel")}</button>
    <button ref={next} type="button" className={`${buttonClass}${mobile ? " is-inverse" : ""}`} disabled={!preview || loading || loadFailed || blocked} onClick={() => { setValue(""); setError(null); setStep(2); }}>{t("commodore.delete.next")}</button>
  </> : <>
    <button type="button" className={buttonClass} onClick={back} disabled={busy}>{t("commodore.delete.back")}</button>
    <button type="button" className={`${buttonClass}${mobile ? " is-danger" : " commodore-delete-confirm"}`} disabled={!matched || busy || blocked} aria-busy={busy} onClick={() => { void submit(); }}>{t(busy ? "commodore.delete.deleting" : "commodore.delete.confirm")}</button>
  </>;
  const [promptBefore, promptAfter = ""] = t("commodore.delete.prompt", { name: "\u0000" }).split("\u0000");
  const body = <>
    <div className="commodore-delete-who">
      <CommodoreAvatar theaterId={commodoreId} state="idle" size={mobile ? 44 : 40} label="" decorative />
      <div><p className="commodore-delete-question" id={questionId}>{t("commodore.delete.question", { name })}</p>
        {step === 1 ? <p className="commodore-delete-lead">{t("commodore.delete.lead")}</p> : null}
        <p className="commodore-delete-lead commodore-delete-irreversible">{t("commodore.delete.irreversible")}</p>
      </div>
    </div>
    {step === 1 ? <>
      {loading ? <><div className="commodore-delete-skeleton" aria-hidden="true"><i /><i /><i /></div><p className="commodore-delete-status" role="status">{t("commodore.delete.loading")}</p></> : loadFailed ? <div className="commodore-delete-failed" role="alert"><span>{t(blocked ? "commodore.delete.inProgress" : "commodore.delete.loadFailed")}</span>{!blocked ? <button type="button" onClick={() => { void fetchPreview(); }}>{t("commodore.delete.retry")}</button> : null}</div> : preview ? <CommodoreDeleteBody preview={preview.data} t={t} /> : null}
    </> : <>
      <p className="commodore-delete-prompt" id={promptId}>{promptBefore}<strong>{name}</strong>{promptAfter}</p>
      <input ref={input} className={`${mobile ? "mobile-field" : "commodore-create-name"} commodore-delete-input`} value={value} placeholder={name} disabled={busy}
        aria-label={t("commodore.delete.inputAria")} aria-describedby={promptId} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="done"
        onChange={(event) => setValue(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setValue(event.currentTarget.value); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!composing && !event.nativeEvent.isComposing && event.keyCode !== 229) void submit(); } }} />
      {error ? <p className="commodore-create-failed" role="alert">{t(`commodore.delete.${error}`)}</p> : null}
      {loading ? <p className="commodore-delete-status" role="status">{t("commodore.delete.loading")}</p> : null}
      {loadFailed && !blocked ? <div className="commodore-delete-failed" role="alert"><span>{t("commodore.delete.loadFailed")}</span><button type="button" onClick={() => { void fetchPreview(); }}>{t("commodore.delete.retry")}</button></div> : null}
    </>}
  </>;
  return renderFrame({ title: t("commodore.delete.title"), closeLabel: t("commodore.delete.cancel"), questionId, step, busy, body, footer, close, back });
}

export function CommodoreDeleteBody({ preview: p, t }: { readonly preview: CommodoreDeletePreview; readonly t: T }) {
  const warning = [p.activeTurn ? t("commodore.delete.warn.turn") : null, p.runningSessions ? t("commodore.delete.warn.sessions", { n: p.runningSessions }) : null,
    p.patrol ? t("commodore.delete.warn.patrol") : null, p.legacyWarning ? t("commodore.delete.warn.legacy") : null].filter((text): text is string => text !== null);
  const meta = [p.objectives.active ? t("commodore.delete.row.active", { n: p.objectives.active }) : null, p.objectives.archived ? t("commodore.delete.row.archived", { n: p.objectives.archived }) : null].filter(Boolean).join(" · ");
  const size = p.diskBytes >= 1e9 ? `${(p.diskBytes / 1e9).toFixed(1)} GB` : p.diskBytes >= 1e6 ? `${Math.round(p.diskBytes / 1e6)} MB` : `${Math.max(1, Math.round(p.diskBytes / 1e3))} KB`;
  const theaterNames = p.commodore.theaters.slice(0, 3).map((theater) => theater.label).join(", ");
  return <>
    {warning.length ? <ul className="commodore-delete-warn" role="note">{warning.map((text) => <li key={text}>{text}</li>)}</ul> : null}
    <section className="commodore-delete-group"><h3>{t("commodore.delete.deletes")}{p.diskBytes > 0 ? <span>{p.diskBytesTruncated ? t("commodore.delete.sizeAtLeast", { size }) : size}</span> : null}</h3>
      <ul className="commodore-delete-list">
        {p.objectives.total ? <><li><span>{t("commodore.delete.row.objectives", { n: p.objectives.total })}</span>{meta ? <span>{meta}</span> : null}</li><li>{t("commodore.delete.row.claudeLogs")}</li></> : null}
        <li>{t("commodore.delete.row.core")}</li>
        {p.memoryEntries ? <li>{t("commodore.delete.row.memory", { n: p.memoryEntries })}</li> : null}
      </ul>
    </section>
    <section className="commodore-delete-group"><h3>{t("commodore.delete.keeps")}</h3><p className="commodore-delete-keep">{t("commodore.delete.keepLine")}
      {p.commodore.theaters.length ? <small>{p.commodore.theaters.length > 3 ? t("commodore.delete.keepTheatersMore", { list: theaterNames, n: p.commodore.theaters.length - 3 }) : t("commodore.delete.keepTheaters", { list: theaterNames })}</small> : null}
    </p></section>
  </>;
}
