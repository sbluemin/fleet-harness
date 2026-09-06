import type { LaunchContextCandidate, LaunchContextProvider } from "@fleet-console/sdk/plugin";

import { fetchSearch } from "./codex/api.js";

/**
 * 실험 "런치 컨텍스트 팩"의 Wiki 몫. 프롬프트에서 뽑은 낱말로 Theater의 Codex 워크스페이스를 검색해
 * 관련 항목을 후보로 낸다. 모델은 부르지 않는다 — 이 표면의 약속은 "검색만"이다. 워크스페이스가
 * 없는 Theater는 빈 목록이며 오류가 아니다.
 */

const MAX_KEYWORDS = 4;
const MAX_CANDIDATES = 4;
const MIN_KEYWORD_LENGTH = 2;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "have", "has", "are", "was", "were",
  "please", "make", "add", "fix", "use", "just", "like", "into", "onto", "about", "over", "after", "before",
  "그리고", "그래서", "하지만", "이거", "저거", "그거", "해줘", "해주세요", "주세요", "부탁", "관련", "대한", "대해", "위해", "그런", "이런",
]);

export function extractLaunchKeywords(prompt: string): readonly string[] {
  const tokens = prompt
    .replace(/[`"'()[\]{}<>.,;:!?/\\|@#$%^&*=+~]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(token.toLowerCase()));
  // 긴 낱말이 더 특징적이다 — 파일명·식별자·전문어가 앞에 온다.
  const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  return unique.slice(0, MAX_KEYWORDS);
}

async function resolveWorkspaceId(theaterId: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch("/api/v1/plugins/codex/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { readonly hasWiki?: unknown; readonly id?: unknown };
  return payload.hasWiki === true && typeof payload.id === "string" ? payload.id : null;
}

export const codexLaunchContextProvider: LaunchContextProvider = {
  id: "codex-wiki",
  collect: async ({ prompt, theaterId, signal }) => {
    const keywords = extractLaunchKeywords(prompt);
    if (keywords.length === 0) return [];
    const workspaceId = await resolveWorkspaceId(theaterId, signal);
    if (!workspaceId) return [];
    const response = await fetchSearch(workspaceId, { q: keywords.join(" "), limit: MAX_CANDIDATES, ...(signal ? { signal } : {}) });
    const candidates: LaunchContextCandidate[] = [];
    for (const entry of response.entries) {
      const excerpt = (entry.excerpt ?? "").trim();
      const detail = [entry.type, entry.updated ? entry.updated.slice(0, 10) : null].filter(Boolean).join(" · ");
      candidates.push({
        id: entry.id,
        kind: "wiki",
        title: entry.title,
        ...(detail ? { detail } : {}),
        text: `${entry.title}${excerpt ? `\n${excerpt}` : ""}\n(wiki:${entry.id})`,
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    return candidates;
  },
};
