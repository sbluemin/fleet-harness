import { useEffect, useMemo, useState } from "react";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";

import { ApiError, listTheaterFolders, type TheaterFolderListResponse } from "../../integration/api.js";
import { describeTheaterFolderFailure } from "../../integration/failure-notices.js";
import { useT } from "../../i18n/index.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileSheet } from "./mobile-sheet.js";

/**
 * Theater 추가 시트(S-15, 전체 높이). 현행 폴더 브라우저의 기능을 시안 문법으로 담는다(D9): 지금 경로(모노), 거르기 입력칸,
 * 위로·절대 경로 이동·브레드크럼·루트 선택, 묶음 행으로 폴더 들어가기. 고르는 단위는 지금 보고 있는 폴더 — 「Theater 추가」가 그 폴더를 등록한다.
 */
export function MobileFolderSheet({ onClose, onConfirm }: { readonly onClose: () => void; readonly onConfirm: (path: string) => void }) {
  const t = useT();
  const [listing, setListing] = useState<TheaterFolderListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState("");

  const load = async (path: string | null, signal?: AbortSignal) => {
    setLoading(true);
    setFailureCode(null);
    setQuery("");
    try { setListing(await listTheaterFolders(path, signal)); }
    catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFailureCode(error instanceof ApiError ? error.message : "");
    } finally { setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, []);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = listing?.entries ?? [];
    return needle === "" ? all : all.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [listing, query]);
  const crumbs = useMemo(() => (listing ? breadcrumbs(listing) : []), [listing]);
  const roots = listing?.roots ?? [];
  const path = listing?.path ?? null;

  return (
    <MobileSheet
      full
      title={t("mobile.sheet.folder.title")}
      onClose={onClose}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-inverse" disabled={path === null || loading} onClick={() => path && onConfirm(path)}>{t("chrome.directoryBrowser.addTheater")}</button>
      </>}
    >
      <p className="mobile-folder-path">{path ?? t("common.loading")}</p>
      {roots.length > 1 ? (
        <div className="mobile-folder-crumbs" role="group" aria-label={t("chrome.directoryBrowser.drives")}>
          {roots.map((root) => <button type="button" key={root} className="mobile-pill-secondary" disabled={loading} onClick={() => void load(root)}>{root.replace(/[\\/]+$/, "") || root}</button>)}
        </div>
      ) : null}
      <nav className="mobile-folder-crumbs" aria-label={t("chrome.directoryBrowser.path")}>
        {crumbs.map((crumb, index) => (
          <button type="button" key={crumb.path} className={`mobile-folder-crumb${index === crumbs.length - 1 ? " is-current" : ""}`} disabled={index === crumbs.length - 1 || loading} onClick={() => void load(crumb.path)}>{crumb.label}</button>
        ))}
      </nav>
      <div className="mobile-folder-tools">
        <input className="mobile-field" value={query} placeholder={t("mobile.sheet.folder.filter")} aria-label={t("chrome.directoryBrowser.filterAria")} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="mobile-pill-secondary" disabled={listing?.parentPath == null || loading} onClick={() => listing?.parentPath != null && void load(listing.parentPath)}>{t("chrome.directoryBrowser.up")}</button>
      </div>
      <div className="mobile-folder-tools">
        <input className="mobile-field" value={jump} placeholder={t("chrome.directoryBrowser.jumpPlaceholder")} aria-label={t("chrome.directoryBrowser.jumpAria")} spellCheck={false} autoComplete="off" onChange={(event) => setJump(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && jump.trim() !== "") void load(jump.trim()); }} />
        <button type="button" className="mobile-pill-secondary" disabled={jump.trim() === "" || loading} onClick={() => void load(jump.trim())}>{t("chrome.directoryBrowser.go")}</button>
      </div>
      {failureCode !== null ? <FailureNotice {...describeTheaterFolderFailure(failureCode, t)} /> : null}
      <div className="mobile-group is-flush" aria-busy={loading}>
        {loading ? <p className="mobile-folder-state">{t("chrome.directoryBrowser.loadingFolders")}</p> : entries.length === 0 ? (
          <p className="mobile-folder-state">{query !== "" ? t("chrome.directoryBrowser.noMatch") : t("chrome.directoryBrowser.noFolders")}</p>
        ) : entries.map((entry) => (
          <button type="button" className="mobile-group-row" key={entry.path} disabled={!entry.accessible || loading} onClick={() => void load(entry.path)}>
            <span className="mobile-group-row-icon"><MobileIcon name="folder" /></span>
            <span className="mobile-group-row-copy">{entry.name}</span>
            {entry.accessible ? <MobileIcon name="right" size={18} className="mobile-group-row-caret" /> : <span className="mobile-folder-locked">{t("chrome.directoryBrowser.locked")}</span>}
          </button>
        ))}
      </div>
      {listing?.truncated ? <p className="mobile-secnote">{t("chrome.directoryBrowser.truncated")}</p> : null}
      <p className="mobile-secnote">{t("chrome.directoryBrowser.trustNotice")}</p>
    </MobileSheet>
  );
}

function breadcrumbs(listing: TheaterFolderListResponse): { label: string; path: string }[] {
  const windows = listing.roots.some((root) => /^[A-Za-z]:\\$/.test(root)) || /^[A-Za-z]:\\/.test(listing.path);
  if (!windows) {
    const segments = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of listing.path.split("/").filter(Boolean)) { accumulated += `/${part}`; segments.push({ label: part, path: accumulated }); }
    return segments;
  }
  const match = /^([A-Za-z]:)\\?/.exec(listing.path);
  const drive = match ? `${match[1]}\\` : (listing.roots[0] ?? "C:\\");
  const segments = [{ label: drive, path: drive }];
  let accumulated = drive.replace(/\\$/, "");
  for (const part of listing.path.slice(drive.length).split("\\").filter(Boolean)) { accumulated += `\\${part}`; segments.push({ label: part, path: accumulated }); }
  return segments;
}
