import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode, RepoEntry, ReposDiscoveryResult } from "../server/types.js";
import "./diff.css";
import { ChangedFiles } from "./changed-files.js";
import { clearSelectedFile, setSelectedFile, type SelectedFile, useSelectedFile } from "./diff-view-store.js";
import { HunkView } from "./hunk-view.js";
import { groupRepos, relativeToParent } from "./repo-grouping.js";

// ─── types ───────────────────────────────────────────────────────────────────

type ViewMode = "list" | "tree";

interface DiffPanelProps {
  readonly ctx: RailPanelContext;
}

interface RepoPickerProps {
  readonly theaterId: string;
  readonly repos: readonly RepoEntry[];
  readonly loading: boolean;
  readonly truncated?: boolean;
  readonly activeSubPath: string;
  readonly depth: number;
  readonly onSelect: (relPath: string) => void;
  readonly onDepthChange: (depth: number) => void;
  readonly onRescan: () => void;
  readonly onClose: () => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_VIEW_MODE = "fleet-console.diff.viewMode";
const PREFS_DEPTH = "fleet-console.diff.depth";
const PREFS_REPO_PREFIX = "fleet-console.diff.repo.";

const EXTENDED_EXTRA_WIDTH = 400;
const DEFAULT_DEPTH = 3;

const DEPTH_OPTS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
  { value: 8, label: "Max" },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function readViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(PREFS_VIEW_MODE);
    if (v === "list" || v === "tree") return v;
  } catch { /* ignore */ }
  return "list";
}

function readDepth(): number {
  try {
    const v = localStorage.getItem(PREFS_DEPTH);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= 1) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_DEPTH;
}

function readSubPath(theaterId: string): string {
  try { return localStorage.getItem(PREFS_REPO_PREFIX + theaterId) ?? ""; } catch { return ""; }
}

function saveSubPath(theaterId: string, relPath: string): void {
  try { localStorage.setItem(PREFS_REPO_PREFIX + theaterId, relPath); } catch { /* ignore */ }
}

// subPath 상태+entry.status에서 HunkView용 모드 결정
function getHunkMode(selected: SelectedFile): DiffFileMode {
  if (selected.entry.status === "U") return "untracked";
  return "unified";
}

// path basename 브라우저 환경 대체
function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

// ─── CommandDeck (저장소 피커 — 패널 전면 불투명 시트) ──────────────────────────

function CommandDeck({ repos, loading, truncated, activeSubPath, depth, onSelect, onDepthChange, onRescan, onClose }: RepoPickerProps) {
  const { groups, topLevelCount } = groupRepos(repos);

  const handleDepthSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) onDepthChange(val);
  }, [onDepthChange]);

  return (
    <div
      className="diff-repo-menu"
      role="listbox"
      aria-label="Repositories"
    >
      <div className="diff-repo-menu-eyebrow">
        <span>REPOSITORIES</span>
        {!loading && <span>{topLevelCount} found · depth {depth}</span>}
      </div>

      <div className="diff-repo-menu-scroll">
        {loading ? (
          <div className="diff-repo-scan">
            <span className="diff-repo-spin" aria-hidden="true" />
            Scanning to depth {depth}…
          </div>
        ) : repos.length === 0 ? (
          <div className="diff-repo-empty">
            No Git repositories within depth {depth}.
          </div>
        ) : (
          groups.map(({ repo, worktrees }) => {
            const isCur = repo.relPath === activeSubPath;
            const isOrphanWorktree = repo.isWorktree === true && repo.worktreeOf === undefined;

            return (
              <div key={repo.relPath} className="diff-repo-group">
                <button
                  type="button"
                  role="option"
                  aria-selected={isCur}
                  className={`diff-repo-opt${isCur ? " is-cur" : ""}`}
                  onClick={() => { onSelect(repo.relPath); onClose(); }}
                >
                  <svg className="diff-repo-mark" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    {isCur && (
                      <path d="M3 7.5L6 10.5L11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                  <span>
                    <span className="diff-repo-line1">
                      <span className="diff-repo-opt-name">{repo.name}</span>
                      <span className="diff-repo-branch">
                        <BranchIcon />
                        <span>{repo.branch}</span>
                      </span>
                      {repo.relPath === "" && <span className="diff-repo-badge diff-repo-badge--root">ROOT</span>}
                      {isOrphanWorktree && <span className="diff-repo-badge diff-repo-badge--worktree">WORKTREE</span>}
                    </span>
                    <span className="diff-repo-opt-path">
                      {repo.relPath === "" ? "· Theater root" : repo.relPath}
                    </span>
                  </span>
                </button>

                {/* 워크트리 자식 — 항상 인라인 트리 연결선 자식 행으로 렌더 */}
                {worktrees.length > 0 && (
                  <div className="diff-repo-children" role="group">
                    {worktrees.map((wt) => {
                      const isWtCur = wt.relPath === activeSubPath;
                      const relLabel = relativeToParent(wt.relPath, repo.relPath);
                      return (
                        <div key={wt.relPath} className="diff-repo-child-row">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isWtCur}
                            className={`diff-repo-opt diff-repo-child-opt${isWtCur ? " is-cur" : ""}`}
                            onClick={() => { onSelect(wt.relPath); onClose(); }}
                          >
                            <svg className="diff-repo-mark" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                              {isWtCur && (
                                <path d="M3 7.5L6 10.5L11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              )}
                            </svg>
                            <span>
                              <span className="diff-repo-line1">
                                <span className="diff-repo-opt-name">{wt.name}</span>
                                <span className="diff-repo-branch">
                                  <BranchIcon />
                                  <span>{wt.branch}</span>
                                </span>
                                <span className="diff-repo-badge diff-repo-badge--worktree">WORKTREE</span>
                              </span>
                              <span className="diff-repo-opt-path">{relLabel}</span>
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}

        {!loading && truncated && (
          <div className="diff-repo-truncated">
            List capped — reduce depth to see all repos.
          </div>
        )}
      </div>

      <div className="diff-repo-menu-foot">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label className="diff-repo-depth">
          Depth
          <select
            value={depth}
            onChange={handleDepthSelect}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {DEPTH_OPTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="diff-repo-rescan" onClick={(e) => { e.stopPropagation(); onRescan(); }}>
          ⟳ Rescan
        </button>
      </div>
    </div>
  );
}

// ─── 아이콘 ───────────────────────────────────────────────────────────────────

function FolderIcon() {
  return (
    <svg className="fico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="bico" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="3" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="3" cy="9" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="3.4" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 4.6v2.8M4.4 3.2H7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M7.4 4.8C6.4 5.4 4.4 5.6 3.6 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="chev" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── DiffPanel ───────────────────────────────────────────────────────────────

function DiffPanel({ ctx }: DiffPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const selectedFile = useSelectedFile(ctx.theaterId ?? null);

  // 저장소 피커 상태
  const [activeSubPath, setActiveSubPath] = useState<string>(
    () => ctx.theaterId ? readSubPath(ctx.theaterId) : "",
  );
  const [depth, setDepth] = useState<number>(readDepth);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reposTruncated, setReposTruncated] = useState(false);
  const fetchSeqRef = useRef(0);
  // depthRef: 렌더 중 동기 갱신 — theater useEffect에서 deps 없이 최신 depth 접근
  const depthRef = useRef(depth);
  depthRef.current = depth;

  const fetchRepos = useCallback((maxDepth: number) => {
    if (!ctx.theaterId) return;
    const seq = ++fetchSeqRef.current;
    setReposLoading(true);
    fetch("/plugins/diff/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, maxDepth }),
    }).then(async (res) => {
      if (seq !== fetchSeqRef.current) return;
      if (!res.ok) { setReposLoading(false); return; }
      const data = await res.json() as ReposDiscoveryResult;
      if (seq !== fetchSeqRef.current) return;
      const fetched = data.repos as RepoEntry[];
      setRepos(fetched);
      setReposTruncated(data.truncated ?? false);
      // theater root가 저장소가 아니면 자동 선택하지 않는다 — 임의 하위 저장소를 여는 것은
      // 사용자에게 혼란을 주므로, 하위 저장소는 드롭다운에서 명시적으로 선택하게 둔다.
      setReposLoading(false);
    }).catch(() => {
      if (seq !== fetchSeqRef.current) return;
      setReposLoading(false);
    });
  }, [ctx.theaterId]);

  // Theater 변경(및 마운트) 시 피커 상태 초기화 + eager fetch
  useEffect(() => {
    if (!ctx.theaterId) return;
    const sp = readSubPath(ctx.theaterId);
    setActiveSubPath(sp);
    setRepos([]);
    setReposTruncated(false);
    setMenuOpen(false);
    clearSelectedFile();
    fetchRepos(depthRef.current);
  }, [ctx.theaterId, fetchRepos]);

  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((open) => !open);
  }, []);

  const handleCloseMenu = useCallback(() => setMenuOpen(false), []);

  const handleSelectRepo = useCallback((relPath: string) => {
    if (relPath === activeSubPath) return;
    setActiveSubPath(relPath);
    if (ctx.theaterId) saveSubPath(ctx.theaterId, relPath);
    clearSelectedFile(); // 저장소 변경 시 선택 파일 초기화
  }, [activeSubPath, ctx.theaterId]);

  const handleDepthChange = useCallback((newDepth: number) => {
    setDepth(newDepth);
    try { localStorage.setItem(PREFS_DEPTH, String(newDepth)); } catch { /* ignore */ }
    fetchRepos(newDepth);
  }, [fetchRepos]);

  const handleRescan = useCallback(() => {
    fetchRepos(depth);
  }, [fetchRepos, depth]);

  // 외부 클릭으로 메뉴 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = () => setMenuOpen(false);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  // Escape 키로 메뉴 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const handleSelectFile = useCallback((entry: DiffFileEntry) => {
    if (!ctx.theaterId) return;
    setSelectedFile(entry, activeSubPath, ctx.theaterId);
  }, [ctx.theaterId, activeSubPath]);

  const handleCloseHunk = useCallback(() => { clearSelectedFile(); }, []);

  const handleViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(PREFS_VIEW_MODE, next); } catch { /* ignore */ }
  }, []);

  // 파일 선택 시 패널 좌측 400px 확장, 해제 시 원복 — 단일 지점 호출
  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(selectedFile ? EXTENDED_EXTRA_WIDTH : null);
  }, [ctx, selectedFile]);

  // 활성 저장소 정보 — 스캔 전에는 subPath 기반 표시 이름만 사용
  const activeRepo = repos.find((r) => r.relPath === activeSubPath) ?? null;
  const activeName = activeRepo?.name
    ?? (activeSubPath === "" ? "Working tree" : basename(activeSubPath) || "Working tree");
  const activeBranch = activeRepo?.branch ?? null;

  const hunkMode: DiffFileMode = selectedFile ? getHunkMode(selectedFile) : "unified";

  return (
    <div
      className={`diff-root${selectedFile ? " has-hunk" : ""}`}
      style={selectedFile ? { gridTemplateColumns: `${EXTENDED_EXTRA_WIDTH}px minmax(0, 1fr)` } : undefined}
    >
      {selectedFile && (
        <div className="diff-hunk-pane">
          <div className="diff-hunk-head">
            <span className={`diff-status-glyph diff-status-${selectedFile.entry.status.toLowerCase()}`}>
              {selectedFile.entry.status}
            </span>
            <span className="diff-hunk-filename">{selectedFile.entry.path}</span>
            <span className="diff-nums">
              {selectedFile.entry.additions > 0 && (
                <span className="diff-additions">+{selectedFile.entry.additions}</span>
              )}
              {selectedFile.entry.deletions > 0 && (
                <span className="diff-deletions">−{selectedFile.entry.deletions}</span>
              )}
            </span>
            <button
              type="button"
              className="diff-hunk-close"
              aria-label="Close diff"
              onClick={handleCloseHunk}
            >
              ✕
            </button>
          </div>
          <div className="diff-hunk-body">
            <HunkView ctx={ctx} file={selectedFile.entry} mode={hunkMode} subPath={selectedFile.subPath} />
          </div>
        </div>
      )}
      <div className="diff-tree-pane">
        <div className="diff-plugin-toolbar">
          <button
            type="button"
            className="diff-repo-trigger"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={handleTriggerClick}
          >
            <FolderIcon />
            <span className="nm">{activeName}</span>
            {activeBranch && (
              <span className="brc">
                <BranchIcon />
                <span className="bnm">{activeBranch}</span>
              </span>
            )}
            <ChevronIcon />
          </button>

          {menuOpen && (
            <CommandDeck
              theaterId={ctx.theaterId ?? ""}
              repos={repos}
              loading={reposLoading}
              truncated={reposTruncated}
              activeSubPath={activeSubPath}
              depth={depth}
              onSelect={handleSelectRepo}
              onDepthChange={handleDepthChange}
              onRescan={handleRescan}
              onClose={handleCloseMenu}
            />
          )}

          <div className="diff-view-toggle">
            <button
              type="button"
              className={`diff-toggle-btn${viewMode === "list" ? " is-active" : ""}`}
              title="List view"
              aria-pressed={viewMode === "list"}
              onClick={() => handleViewMode("list")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={`diff-toggle-btn${viewMode === "tree" ? " is-active" : ""}`}
              title="Tree view"
              aria-pressed={viewMode === "tree"}
              onClick={() => handleViewMode("tree")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>
        </div>
        <ChangedFiles
          ctx={ctx}
          viewMode={viewMode}
          selectedPath={selectedFile?.entry.path ?? null}
          subPath={activeSubPath}
          onSelect={handleSelectFile}
        />
      </div>
    </div>
  );
}

// ─── DiffIcon ────────────────────────────────────────────────────────────────

function DiffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" />
      <rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" />
      <line x1="14" y1="2" x2="14" y2="16" stroke="currentColor" strokeWidth="1.2" />
      <polyline points="12,4 14,2 16,4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <polyline points="12,14 14,16 16,14" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export const diffPanel: RailPanelDescriptor = {
  id: "diff",
  title: "Diff",
  icon: () => <DiffIcon />,
  render: (ctx: RailPanelContext) => <DiffPanel ctx={ctx} />,
};
