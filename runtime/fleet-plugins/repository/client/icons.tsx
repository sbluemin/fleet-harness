import type { ReactElement, SVGProps } from "react";

/**
 * Repository 글리프 세트 — 16 그리드, 1.5 스트로크, 둥근 끝단 한 벌.
 * 렌더 크기는 행 14 · 버튼 14 · 트리거 16 · 배지 12 네 단계만 쓴다.
 * 유니코드 문자 글리프(⇩ ⇧ ▤ ↻ ⇆ ⌄ ‹ ›)는 폰트에 따라 굵기·정렬이 흔들려 전부 SVG로 대체한다.
 */
export type RepositoryIconName =
  | "branch" | "check" | "folder" | "repo" | "cloud" | "globe" | "github" | "tag" | "stash" | "submodule"
  | "pull" | "push" | "fetch" | "compare" | "refresh" | "chevron" | "close" | "copy" | "commit" | "search"
  | "clock" | "changes" | "history" | "parent" | "child" | "expand" | "detach" | "more" | "minus" | "plus";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const SHAPES: Record<RepositoryIconName, ReactElement> = {
  branch: <g {...STROKE}><circle cx="4" cy="3.25" r="1.75" /><circle cx="4" cy="12.75" r="1.75" /><circle cx="12" cy="4.75" r="1.75" /><path d="M4 5v6M12 6.5C12 9.5 8.5 10.2 4 11" /></g>,
  check: <path {...STROKE} strokeWidth={1.75} d="M3.5 8.5l3 3 6-7" />,
  folder: <path {...STROKE} d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12z" />,
  repo: <g {...STROKE}><path d="M3 3.5A1.5 1.5 0 014.5 2H13v10.5H4.5A1.5 1.5 0 003 14V3.5z" /><path d="M3 12A1.5 1.5 0 014.5 10.5H13M6 5h4" /></g>,
  cloud: <path {...STROKE} d="M4.75 12.5A2.75 2.75 0 014.4 7a3.75 3.75 0 017.25.9 2.35 2.35 0 01-.4 4.6z" />,
  globe: <g {...STROKE}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.75 1.75 2.5 3.5 2.5 5.5S9.75 11.75 8 13.5C6.25 11.75 5.5 10 5.5 8S6.25 4.25 8 2.5z" /></g>,
  github: <path fill="currentColor" d="M8 .8a7.2 7.2 0 00-2.28 14.03c.36.07.49-.16.49-.35v-1.22c-2 .43-2.42-.97-2.42-.97-.33-.83-.8-1.05-.8-1.05-.65-.45.05-.44.05-.44.72.05 1.1.74 1.1.74.64 1.1 1.68.78 2.1.6.06-.47.25-.78.45-.96-1.6-.18-3.28-.8-3.28-3.56 0-.79.28-1.43.74-1.93-.07-.18-.32-.92.07-1.91 0 0 .6-.19 1.98.74a6.9 6.9 0 013.6 0c1.37-.93 1.97-.74 1.97-.74.4.99.15 1.73.07 1.91.46.5.74 1.14.74 1.93 0 2.77-1.69 3.38-3.3 3.56.26.22.49.66.49 1.33v1.97c0 .19.13.42.5.35A7.2 7.2 0 008 .8z" />,
  tag: <g {...STROKE}><path d="M2.5 2.5h5.25l5.75 5.75-5.25 5.25L2.5 7.75z" /><circle cx="5.75" cy="5.75" r="1" fill="currentColor" stroke="none" /></g>,
  stash: <g {...STROKE}><path d="M2.5 3.5h11v9h-11z" /><path d="M2.5 9h3.25l1 1.5h2.5l1-1.5h3.25" /></g>,
  submodule: <g {...STROKE}><path d="M2.5 2.5h6v6h-6z" /><path d="M8.5 6h5v7.5h-7.5v-5" /></g>,
  pull: <path {...STROKE} d="M8 2.5v8M4.75 7.25L8 10.5l3.25-3.25M3 13.5h10" />,
  push: <path {...STROKE} d="M8 13.5v-8M4.75 8.75L8 5.5l3.25 3.25M3 2.5h10" />,
  fetch: <g {...STROKE}><path d="M4.5 10.75A2.6 2.6 0 014.4 5.6a3.75 3.75 0 017.25.9 2.3 2.3 0 01.4 4.25" /><path d="M8 8v6M5.75 11.75L8 14l2.25-2.25" /></g>,
  compare: <path {...STROKE} d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />,
  refresh: <g {...STROKE}><path d="M13 8a5 5 0 01-8.6 3.5M3 8a5 5 0 018.6-3.5" /><path d="M11.75 2v2.75H9M4.25 14v-2.75H7" /></g>,
  chevron: <path {...STROKE} d="M4 6l4 4 4-4" />,
  close: <path {...STROKE} d="M4 4l8 8M12 4l-8 8" />,
  copy: <g {...STROKE}><path d="M5.5 5.5h7v7h-7z" /><path d="M3.5 10.5v-7h7" /></g>,
  commit: <g {...STROKE}><circle cx="8" cy="8" r="2.5" /><path d="M2 8h3.5M10.5 8H14" /></g>,
  search: <g {...STROKE}><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5" /></g>,
  clock: <g {...STROKE}><circle cx="8" cy="8" r="5.5" /><path d="M8 4.75V8l2.25 1.5" /></g>,
  changes: <path {...STROKE} d="M3 4h10M3 8h10M3 12h6" />,
  history: <path {...STROKE} d="M4 2.5v11M8 5.5v8M12 8.5v5" />,
  parent: <path {...STROKE} d="M10 3.5L5.5 8l4.5 4.5" />,
  child: <path {...STROKE} d="M6 3.5L10.5 8 6 12.5" />,
  expand: <path {...STROKE} d="M4 9.5l4-4 4 4" />,
  detach: <g {...STROKE}><circle cx="8" cy="8" r="2.5" /><path d="M8 2v3.5M8 10.5V14" strokeDasharray="1.5 2" /></g>,
  more: <g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" /></g>,
  minus: <path {...STROKE} d="M3.5 8h9" />,
  plus: <path {...STROKE} d="M8 3.5v9M3.5 8h9" />,
};

export function Icon({ name, size = 14, className, ...rest }: { readonly name: RepositoryIconName; readonly size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return <svg className={className ? `repository-icon ${className}` : "repository-icon"} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...rest}>{SHAPES[name]}</svg>;
}

/** 원격 호스트 → 마크. github.com만 상표 마크를 쓰고 그 외는 cloud. */
export function remoteHostIcon(host: string | null | undefined): RepositoryIconName {
  return host === "github.com" ? "github" : "cloud";
}
