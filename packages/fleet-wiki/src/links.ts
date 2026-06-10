import path from "node:path";

import type { WikiEntry } from "./types.js";

export interface LegacyMarkdownWikiLink {
  target: string;
  entryId: string;
}

export interface WikiLinkReplacementOptions {
  hrefPrefix?: string;
}

export const WIKI_LINK_PATTERN = /\[\[wiki:([^\]]+)\]\]/g;
export const MARKDOWN_LINK_PATTERN = /\[[^\]]*]\(([^)]+)\)/g;

export function extractWikiLinks(body: string): string[] {
  return [...body.matchAll(WIKI_LINK_PATTERN)]
    .map((match) => match[1]?.trim())
    .filter((id): id is string => Boolean(id));
}

// 전체 엔트리 본문의 [[wiki:id]] 링크에서 backlink 역인덱스를 만든다(링크 대상 id → 참조하는 entry id 집합).
// 정렬/배열 변환 등 출력 형태 가공은 각 호출부 책임으로 남긴다.
export function buildBacklinksIndex(entries: WikiEntry[]): Map<string, Set<string>> {
  const backlinks = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const linkedId of extractWikiLinks(entry.body)) {
      const refs = backlinks.get(linkedId) ?? new Set<string>();
      refs.add(entry.id);
      backlinks.set(linkedId, refs);
    }
  }
  return backlinks;
}

export function extractMarkdownLinkTargets(body: string): string[] {
  return [...body.matchAll(MARKDOWN_LINK_PATTERN)]
    .map((match) => match[1]?.trim())
    .filter((target): target is string => Boolean(target));
}

export function extractLegacyMarkdownWikiLinks(
  body: string,
  wikiDir: string,
  basePath: string,
): LegacyMarkdownWikiLink[] {
  const links: LegacyMarkdownWikiLink[] = [];
  for (const target of extractMarkdownLinkTargets(body)) {
    const resolved = resolveLegacyWikiTarget(target, wikiDir, basePath);
    if (resolved) {
      links.push(resolved);
    }
  }
  return links;
}

export function replaceWikiLinksWithMarkdown(body: string, options?: WikiLinkReplacementOptions): string {
  const hrefPrefix = options?.hrefPrefix ?? "#fleet-wiki:";
  return body.replace(WIKI_LINK_PATTERN, (_match, rawId: string) => {
    const id = rawId.trim();
    if (!id) return "";
    return `[${id}](${hrefPrefix}${encodeURIComponent(id)})`;
  });
}

function resolveLegacyWikiTarget(
  target: string,
  wikiDir: string,
  basePath: string,
): LegacyMarkdownWikiLink | null {
  if (!target || target.startsWith("#")) return null;
  if (path.isAbsolute(target)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;

  const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  if (!withoutFragment.endsWith(".md")) return null;

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(withoutFragment);
  } catch {
    return null;
  }

  const resolved = path.resolve(path.dirname(basePath), decodedTarget);
  const relative = path.relative(wikiDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  return {
    target,
    entryId: path.basename(relative, ".md"),
  };
}
