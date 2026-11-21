import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { FailureNotice } from "../../../../../features/execution/client/components/failure-notice.js";

import { ApiError, listTheaterFolders, type TheaterFolderListResponse } from "../../integration/api.js";
import { describeTheaterFolderFailure } from "../../integration/failure-notices.js";
import { useT } from "../../i18n/index.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileSheet } from "./mobile-sheet.js";

export interface FolderTargetCommodore {
  readonly commodoreId: string;
  readonly label: string;
}

/**
 * Theater 추가 시트(S-15, 전체 높이). 지금 경로(모노), 거르기 입력칸,
 * 위로·절대 경로 이동·브레드크럼·루트 선택, 묶음 행으로 폴더 들어가기.
 * 하위 폴더를 라디오로 고르거나, 고르지 않으면 지금 열려 있는 폴더 자체를 「이 폴더 추가」로 등록한다.
 */
export function MobileFolderSheet({
  onClose,
  onConfirm,
  commodores,
  initialCommodoreId,
}: {
  readonly onClose: () => void;
  readonly onConfirm: (path: string, commodoreId?: string | null) => void;
  readonly commodores?: readonly FolderTargetCommodore[];
  readonly initialCommodoreId?: string | null;
}) {
  const t = useT(true);
  const [listing, setListing] = useState<TheaterFolderListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState("");
  // 고른 하위 폴더(라디오). 비어 있으면 지금 열려 있는 폴더 자체를 추가 대상으로 삼는다.
  const [picked, setPicked] = useState<string | null>(null);
  const [selectedCommodoreId, setSelectedCommodoreId] = useState<string | null>(() => {
    if (!commodores || commodores.length === 0) return initialCommodoreId ?? null;
    if (initialCommodoreId && commodores.some((item) => item.commodoreId === initialCommodoreId)) return initialCommodoreId;
    return commodores[0]!.commodoreId;
  });

  const load = async (path: string | null, signal?: AbortSignal) => {
    setLoading(true);
    setFailureCode(null);
    setQuery("");
    setPicked(null);
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
  // 경로 칩 띠는 폰 폭보다 길어지기 쉽다 — 지금 폴더(마지막 칩)가 늘 보이게, 경로가 바뀔 때마다(열기·위로·칩·들어가기) 띠를 끝으로 민다.
  const crumbsRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const strip = crumbsRef.current;
    if (strip) strip.scrollLeft = strip.scrollWidth;
  }, [crumbs]);
  const roots = listing?.roots ?? [];
  const path = listing?.path ?? null;
  const targetPath = picked ?? path;
  const windowsPaths = path !== null ? /^[A-Za-z]:\\/.test(path) : roots.some((root) => /^[A-Za-z]:\\$/.test(root));

  return (
    <MobileSheet
      full
      focusInputOnTouch={false}
      title={t("mobile.sheet.folder.title")}
      onClose={onClose}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button
          type="button"
          className="mobile-pill-secondary is-inverse"
          disabled={targetPath === null || loading}
          onClick={() => targetPath !== null && onConfirm(targetPath, selectedCommodoreId)}
        >
          {picked !== null ? t("chrome.directoryBrowser.addTheater") : t("mobile.sheet.folder.addCurrent")}
        </button>
      </>}
    >
      {commodores && commodores.length > 0 ? (
        <div className="mobile-folder-target" role="group" aria-label={t("mobile.sheet.folder.targetCommodore")}>
          <span className="mobile-folder-target-label">{t("mobile.sheet.folder.targetCommodore")}</span>
          <div className="mobile-folder-target-chips">
            {commodores.map((commodore) => (
              <button
                key={commodore.commodoreId}
                type="button"
                data-press="r1"
                className={`mobile-conv-chip${selectedCommodoreId === commodore.commodoreId ? " is-on" : ""}`}
                aria-pressed={selectedCommodoreId === commodore.commodoreId}
                onClick={() => setSelectedCommodoreId(commodore.commodoreId)}
              >
                {commodore.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="mobile-folder-path">{path ?? t("common.loading")}</p>
      {roots.length > 1 ? (
        <div className="mobile-folder-crumbs" role="group" aria-label={t("chrome.directoryBrowser.drives")}>
          {roots.map((root) => <button type="button" key={root} className="mobile-pill-secondary" disabled={loading} onClick={() => void load(root)}>{root.replace(/[\\/]+$/, "") || root}</button>)}
        </div>
      ) : null}
      <nav ref={crumbsRef} className="mobile-folder-crumbs is-path" aria-label={t("chrome.directoryBrowser.path")}>
        {crumbs.map((crumb, index) => (
          <button type="button" key={crumb.path} className={`mobile-folder-crumb${index === crumbs.length - 1 ? " is-current" : ""}`} disabled={index === crumbs.length - 1 || loading} onClick={() => void load(crumb.path)}>{crumb.label}</button>
        ))}
      </nav>
      <div className="mobile-folder-tools">
        <input className="mobile-field" value={query} placeholder={t("mobile.sheet.folder.filter")} aria-label={t("chrome.directoryBrowser.filterAria")} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="mobile-pill-secondary" disabled={listing?.parentPath == null || loading} onClick={() => listing?.parentPath != null && void load(listing.parentPath)}>{t("chrome.directoryBrowser.up")}</button>
      </div>
      <div className="mobile-folder-tools">
        <input className="mobile-field" value={jump} placeholder={t("mobile.sheet.folder.jumpPlaceholder", { example: windowsPaths ? "D:\\projects" : "~/workspace" })} aria-label={t("chrome.directoryBrowser.jumpAria")} spellCheck={false} autoComplete="off" onChange={(event) => setJump(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && jump.trim() !== "") void load(jump.trim()); }} />
        <button type="button" className="mobile-pill-secondary" disabled={jump.trim() === "" || loading} onClick={() => void load(jump.trim())}>{t("chrome.directoryBrowser.go")}</button>
      </div>
      {failureCode !== null ? <FailureNotice {...describeTheaterFolderFailure(failureCode, t)} /> : null}
      <div className="mobile-group is-flush" aria-busy={loading}>
        {loading ? <p className="mobile-folder-state">{t("chrome.directoryBrowser.loadingFolders")}</p> : entries.length === 0 ? (
          <p className="mobile-folder-state">{query !== "" ? t("chrome.directoryBrowser.noMatch") : t("chrome.directoryBrowser.noFolders")}</p>
        ) : entries.map((entry) => (
          <div className="mobile-group-row mobile-folder-row" key={entry.path}>
            {/* 고르기(라디오)와 들어가기(›)를 나눈다 — 왼쪽 행은 고르고, 오른쪽 ›는 그 폴더 안으로 간다. */}
            <button type="button" role="radio" aria-checked={picked === entry.path} className="mobile-folder-pick" disabled={!entry.accessible || loading} onClick={() => setPicked(entry.path)}>
              <span className={`mobile-radio${picked === entry.path ? " is-on" : ""}`} aria-hidden="true" />
              <span className="mobile-group-row-icon"><MobileIcon name="folder" /></span>
              <span className="mobile-group-row-copy">{entry.name}</span>
            </button>
            {entry.accessible ? (
              <button type="button" className="mobile-folder-enter" aria-label={t("mobile.sheet.folder.enter", { name: entry.name })} disabled={loading} onClick={() => void load(entry.path)}><MobileIcon name="right" size={18} /></button>
            ) : <span className="mobile-folder-locked">{t("chrome.directoryBrowser.locked")}</span>}
          </div>
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
