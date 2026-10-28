import { useEffect, useState } from "react";
import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import type { SharedFolderEntry, SharedFolderList } from "../shared/shared-folder.js";
import type { Objective } from "../shared/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { absolute, bytesLabel, relative, useNow } from "./result-content.js";
import { openSharedFolderWindow } from "./result-window.js";
import { sharedFileUrl, sharedListUrl } from "./shared-folder-url.js";

type T = Translate<ObjectiveMessageKey>;
type Load = { readonly objectiveId: string; readonly list: SharedFolderList | null; readonly failed: boolean };

/**
 * 공유 폴더 목록 — 펼쳐 있는 동안만 읽고, 그 목표의 보드 객체가 바뀔 때 다시 읽는다. 폴링·새로 고침 단추는 없다.
 * 다시 읽는 동안에는 이전 목록을 그대로 둔다. 다른 목표의 응답은 쓰지 않는다.
 */
export function useSharedFolder(objective: Objective, open: boolean): { readonly list: SharedFolderList | null; readonly failed: boolean } {
  const [load, setLoad] = useState<Load | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const objectiveId = objective.id;
    fetch(sharedListUrl(objectiveId), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`http_${response.status}`);
        return (await response.json()) as SharedFolderList;
      })
      .then((list) => setLoad({ objectiveId, list, failed: false }))
      .catch(() => { if (!controller.signal.aborted) setLoad({ objectiveId, list: null, failed: true }); });
    return () => controller.abort();
  }, [open, objective]);
  return load?.objectiveId === objective.id ? load : { list: null, failed: false };
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

/** 평면 목록 몸통 — 증거 텍스트 행 문법(`.objectives-result-row`)을 그대로 쓴다. */
export function SharedFolderRows({ objective, t, language, state }: {
  readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale;
  readonly state: { readonly list: SharedFolderList | null; readonly failed: boolean };
}) {
  const now = useNow();
  const { list, failed } = state;
  if (failed) return <p className="objectives-shared-note" role="status">{t("objectives.shared.failed")}</p>;
  if (!list) return <p className="objectives-shared-note" role="status">{t("objectives.shared.loading")}</p>;
  if (list.entries.length === 0) return <p className="objectives-shared-note" role="status">{t("objectives.shared.empty")}</p>;
  const view = (entry: SharedFolderEntry, opener: HTMLElement | null) => openSharedFolderWindow(objective.id, entry, opener);
  return <>
    {list.entries.map((entry) => {
      const name = basename(entry.path);
      const folder = folderOf(entry.path);
      const previewable = entry.kind !== "file";
      return <div key={entry.path} className={`objectives-result-row${previewable ? " is-button" : ""}`} onClick={previewable ? (event) => {
        if (event.target instanceof Element && event.target.closest("a, button") || window.getSelection()?.toString()) return;
        view(entry, event.currentTarget.querySelector<HTMLElement>("button.objectives-result-open"));
      } : undefined}>
        <span className="objectives-row-ic">{entry.kind === "image" ? <ImageGlyph /> : entry.kind === "text" ? <DocGlyph /> : <FileGlyph />}</span>
        <span className="objectives-result-body">
          <span className="objectives-result-title is-mono" title={entry.path}>{name}</span>
          <span className="objectives-result-sub">{folder ? <span className="objectives-shared-dir">{folder}</span> : null}{t(`objectives.shared.kind.${entry.kind}`)} · {bytesLabel(entry.bytes)} · <time dateTime={new Date(entry.modifiedAt).toISOString()} title={absolute(entry.modifiedAt, language)}>{relative(entry.modifiedAt, now, language)}</time></span>
        </span>
        {previewable
          ? <button type="button" className="objectives-result-open" aria-label={t("objectives.shared.openAria", { name: entry.path })} onClick={(event) => view(entry, event.currentTarget)}>{t("objectives.shared.open")}</button>
          : <a className="objectives-result-open" href={sharedFileUrl(objective.id, entry.path, true)} download aria-label={t("objectives.shared.downloadAria", { name: entry.path })}>{t("objectives.shared.download")}</a>}
      </div>;
    })}
    {list.truncated ? <p className="objectives-shared-note" role="status">{t("objectives.shared.truncated")}</p> : null}
  </>;
}

/** 폰 — 섹션 제목을 눌러 접고 펴는 머리 + 카드. 기본 접힘, 머리에는 개수·배지를 두지 않는다. */
export function MobileSharedFolder({ objective, t, language }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale }) {
  const [open, setOpen] = useState(false);
  const state = useSharedFolder(objective, open);
  const bodyId = `objectives-m-shared-${objective.id}`;
  return <>
    <h2 className="objectives-m-glab">
      <button type="button" className="objectives-m-fold" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((current) => !current)}>
        <span className="objectives-m-fold-ic"><FolderGlyph /></span>{t("objectives.shared.title")}
        <span className="objectives-section-chev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5L10.5 8 6 12.5" /></svg></span>
      </button>
    </h2>
    <div id={bodyId} hidden={!open}>
      {open ? <div className="objectives-m-results objectives-m-shared"><div className="objectives-results"><section className="objectives-result-group"><div className="objectives-result-group-body"><SharedFolderRows objective={objective} t={t} language={language} state={state} /></div></section></div></div> : null}
    </div>
  </>;
}

export const FolderGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>;
const ImageGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="5.8" cy="6" r="1.1" /><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3" /></svg>;
const DocGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13M5.8 8.5h4.4M5.8 11h3" /></svg>;
const FileGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13" /></svg>;
