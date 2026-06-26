import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { ApiError, listTheaterFolders, type TheaterFolderListResponse } from "../api.js";

interface DirectoryBrowserModalProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (path: string) => void;
}

// 경로 한 마디 = breadcrumb 항로 위의 한 구역. path는 그 마디까지 누적된 절대 경로다.
interface BreadcrumbSegment {
  readonly label: string;
  readonly path: string;
}

const LIST_ID = "directory-browser-sectors";

export function DirectoryBrowserModal({ open, onCancel, onConfirm }: DirectoryBrowserModalProps) {
  const [listing, setListing] = useState<TheaterFolderListResponse | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jumpPath, setJumpPath] = useState("");
  const [highlight, setHighlight] = useState(0);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 디렉터리 한 레벨을 정찰해 목록으로 받는다. 진입/상위이동/breadcrumb 점프가 모두 이 경로를 탄다.
  const loadPath = async (path: string | null, signal?: AbortSignal) => {
    setLoadingPath(path);
    setError(null);
    setQuery("");
    setHighlight(0);
    try {
      const next = await listTheaterFolders(path, signal);
      setListing(next);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof ApiError ? loadError.message : String(loadError));
    } finally {
      setLoadingPath(null);
    }
  };

  // 모달이 열리는 순간 홈 디렉터리부터 정찰을 시작한다. 닫히면 abort.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadPath(null, controller.signal);
    return () => controller.abort();
    // loadPath는 매 렌더 새로 만들어지지만 open 전이에서만 트리거하면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 진입할 때마다 필터 입력에 포커스를 둬 곧바로 타이핑 검색이 가능하게 한다.
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open, listing?.path]);

  const entries = listing?.entries ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [entries, query]);

  const breadcrumb = useMemo(() => (listing ? buildBreadcrumb(listing) : []), [listing]);
  const activeDrive = listing ? getDrivePrefix(listing.path) : null;
  const roots = listing?.roots ?? [];
  const showRoots = roots.length > 1;

  // filtered가 줄면 하이라이트가 범위를 벗어날 수 있으니 항상 끝으로 클램프한다.
  const activeIndex = filtered.length === 0 ? -1 : Math.min(highlight, filtered.length - 1);

  // 하이라이트된 구역을 항상 보이도록 스크롤한다.
  useEffect(() => {
    if (activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listing?.path]);

  if (!open) return null;

  const enterSector = (entry: { readonly path: string; readonly accessible: boolean }) => {
    if (entry.accessible && loadingPath === null) void loadPath(entry.path);
  };

  const goUp = () => {
    if (listing?.parentPath != null && loadingPath === null) void loadPath(listing.parentPath);
  };

  const jumpToPath = () => {
    const target = jumpPath.trim();
    if (target !== "" && loadingPath === null) void loadPath(target);
  };

  const currentPath = listing?.path ?? null;
  const activeRowId = activeIndex >= 0 ? `${LIST_ID}-${activeIndex}` : undefined;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "Escape":
        // 필터가 차 있으면 먼저 비우고, 비어 있으면 모달을 닫는다.
        if (query !== "") setQuery("");
        else onCancel();
        return;
      case "ArrowDown":
        event.preventDefault();
        setHighlight((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)));
        return;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((value) => Math.max(value - 1, 0));
        return;
      case "Enter": {
        event.preventDefault();
        const target = filtered[activeIndex];
        if (target) enterSector(target);
        return;
      }
      case "Backspace":
        // 빈 필터에서의 Backspace만 상위 구역으로 — 입력 편집을 방해하지 않는다.
        if (query === "") {
          event.preventDefault();
          goUp();
        }
        return;
      default:
        return;
    }
  };

  return createPortal(
    <div className="directory-browser-overlay" role="presentation">
      <button type="button" className="directory-browser-scrim" aria-label="Close" onClick={onCancel} />
      <section
        className="directory-browser-card"
        role="dialog"
        aria-modal="true"
        aria-label="Establish Theater of Operations"
        onKeyDown={handleKeyDown}
      >
        <header className="directory-browser-header">
          <span className="directory-browser-sigil" aria-hidden="true"><TheaterSigil /></span>
          <div className="directory-browser-heading">
            <span className="directory-browser-kicker">Theater of Operations</span>
            <h2>Establish Theater</h2>
          </div>
          <button type="button" className="directory-browser-close" onClick={onCancel} aria-label="Close">×</button>
        </header>

        {showRoots ? (
          <div className="directory-browser-roots" role="group" aria-label="Drives">
            <span className="directory-browser-kicker">Stations</span>
            <div className="directory-browser-root-chips">
              {roots.map((root) => {
                const isActive = activeDrive != null && getDrivePrefix(root) === activeDrive;
                return (
                  <button
                    type="button"
                    key={root}
                    className={`directory-browser-root-chip ${isActive ? "is-active" : ""}`}
                    aria-current={isActive ? "location" : undefined}
                    disabled={loadingPath !== null}
                    title={root}
                    onClick={() => {
                      if (loadingPath === null) void loadPath(root);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {formatRootLabel(root)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <nav className="directory-browser-course" aria-label="Path">
          {breadcrumb.map((segment, index) => {
            const isLast = index === breadcrumb.length - 1;
            return (
              <span className="directory-browser-course-seg" key={segment.path}>
                {index > 0 ? <span className="directory-browser-course-sep" aria-hidden="true">›</span> : null}
                <button
                  type="button"
                  className={`directory-browser-crumb ${isLast ? "is-current" : ""}`}
                  aria-current={isLast ? "location" : undefined}
                  disabled={isLast || loadingPath !== null}
                  title={segment.path}
                  onClick={() => void loadPath(segment.path)}
                >
                  {segment.label}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="directory-browser-toolbar">
          <div className="directory-browser-filter">
            <span className="directory-browser-filter-glyph" aria-hidden="true"><ScanGlyph /></span>
            <input
              ref={filterRef}
              type="text"
              className="directory-browser-filter-input"
              placeholder="Filter sectors…"
              aria-label="Filter folders"
              aria-controls={LIST_ID}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
            />
          </div>
          <button
            type="button"
            className="directory-browser-up"
            disabled={listing?.parentPath == null || loadingPath !== null}
            title="Up one sector (Backspace)"
            onClick={goUp}
          >
            <UpGlyph />
            <span>Up</span>
          </button>
        </div>

        <div className="directory-browser-jump">
          <input
            type="text"
            className="directory-browser-jump-input"
            placeholder="Or jump to a path — e.g. D:\\projects"
            aria-label="Jump to absolute path"
            value={jumpPath}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setJumpPath(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                jumpToPath();
              }
            }}
          />
          <button
            type="button"
            className="directory-browser-jump-button"
            disabled={jumpPath.trim() === "" || loadingPath !== null}
            onClick={jumpToPath}
            onKeyDown={(event) => event.stopPropagation()}
          >
            Go
          </button>
        </div>

        {error ? <p className="directory-browser-error" role="alert">{error}</p> : null}

        <div
          className="directory-browser-list"
          id={LIST_ID}
          role="listbox"
          aria-label="Folders"
          aria-busy={loadingPath !== null}
          aria-activedescendant={activeRowId}
          ref={listRef}
        >
          {loadingPath !== null ? (
            <p className="directory-browser-state is-live"><span className="directory-browser-scan-dot" aria-hidden="true" />Scouting…</p>
          ) : filtered.length === 0 ? (
            <p className="directory-browser-state">{query !== "" ? "No sectors match the filter." : "No sectors to advance into."}</p>
          ) : (
            filtered.map((entry, index) => (
              <div
                key={entry.path}
                id={`${LIST_ID}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={!entry.accessible}
                className={`directory-browser-sector ${index === activeIndex ? "is-active" : ""} ${entry.accessible ? "" : "is-locked"}`}
                title={entry.path}
                onClick={() => {
                  setHighlight(index);
                  enterSector(entry);
                }}
              >
                <span className="directory-browser-sector-glyph" aria-hidden="true"><FolderGlyph /></span>
                <span className="directory-browser-sector-name">{entry.name}</span>
                {entry.accessible ? (
                  <span className="directory-browser-sector-advance" aria-hidden="true">›</span>
                ) : (
                  <span className="directory-browser-sector-lock"><LockGlyph /> Locked</span>
                )}
              </div>
            ))
          )}
        </div>

        {listing?.truncated ? <p className="directory-browser-note">Charting first 500 sectors only.</p> : null}

        <footer className="directory-browser-actions">
          <div className="directory-browser-target">
            <span className="directory-browser-target-label">Theater Root</span>
            <span className="directory-browser-target-path" title={currentPath ?? ""}>{currentPath ?? "Scouting…"}</span>
          </div>
          <div className="directory-browser-buttons">
            <button type="button" className="directory-browser-button" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="directory-browser-button is-primary"
              disabled={currentPath === null || loadingPath !== null}
              onClick={() => currentPath && onConfirm(currentPath)}
            >
              Establish Theater
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

// 현재 절대 경로를 breadcrumb 마디 배열로 분해한다. 루트(/ 또는 C:\)가 항상 첫 마디다.
function buildBreadcrumb(listing: TheaterFolderListResponse): BreadcrumbSegment[] {
  const separator = detectSeparator(listing);
  if (separator === "/") {
    const segments: BreadcrumbSegment[] = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of listing.path.split("/").filter(Boolean)) {
      accumulated += `/${part}`;
      segments.push({ label: part, path: accumulated });
    }
    return segments;
  }
  const driveMatch = /^([A-Za-z]:)\\?/.exec(listing.path);
  const drive = driveMatch ? `${driveMatch[1]}\\` : (listing.roots[0] ?? "C:\\");
  const segments: BreadcrumbSegment[] = [{ label: drive, path: drive }];
  let accumulated = drive.replace(/\\$/, "");
  for (const part of listing.path.slice(drive.length).split("\\").filter(Boolean)) {
    accumulated += `\\${part}`;
    segments.push({ label: part, path: accumulated });
  }
  return segments;
}

// win32 드라이브 루트(C:\)나 백슬래시 경로면 \, 그 외에는 POSIX /.
function detectSeparator(listing: TheaterFolderListResponse): "\\" | "/" {
  if (listing.roots.some((root) => /^[A-Za-z]:\\$/.test(root))) return "\\";
  if (/^[A-Za-z]:\\/.test(listing.path)) return "\\";
  return "/";
}

function getDrivePrefix(path: string): string | null {
  const match = /^([A-Za-z]:)\\?/.exec(path);
  return match?.[1]?.toLowerCase() ?? null;
}

function formatRootLabel(root: string): string {
  return root.replace(/[\\/]+$/, "") || root;
}

function TheaterSigil() {
  // 작전구역(Theater of Operations) — 측위 레티클: 동심 링 + 십자 조준선으로 '구역을 조준해 지정'을 표상한다.
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="2.1" fill="currentColor" />
      <path d="M10 1.6v3.2M10 15.2v3.2M1.6 10h3.2M15.2 10h3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M2.4 5.2c0-.7.6-1.3 1.3-1.3h2.7l1.4 1.5h6.5c.7 0 1.3.6 1.3 1.3v6.4c0 .7-.6 1.3-1.3 1.3H3.7c-.7 0-1.3-.6-1.3-1.3z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

function ScanGlyph() {
  // 정찰/탐색 — 돋보기.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 10.2 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function UpGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.6" y="7" width="8.8" height="6.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
