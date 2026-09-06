import type { LaunchContextCandidate, LaunchContextProvider } from "@fleet-console/sdk/plugin";

import type { LogResult } from "../server/types.js";

/**
 * 실험 "런치 컨텍스트 팩"의 저장소 몫 — Theater 루트 체크아웃의 최근 커밋 몇 개를 후보로 낸다.
 * 프롬프트와의 관련은 제목에 프롬프트 낱말이 들어가는지로만 거른다(모델 없음). 하나도 겹치지
 * 않으면 가장 최근 커밋 두 개를 그대로 낸다 — "지금 저장소가 어디까지 왔는가"는 어떤 프롬프트에도
 * 배경이 된다. git 저장소가 아닌 Theater는 빈 목록이다.
 */

const LOG_LIMIT = 30;
const MAX_CANDIDATES = 3;
const RECENT_FALLBACK = 2;

function promptWords(prompt: string): readonly string[] {
  return [...new Set(prompt.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").split(/\s+/u).filter((word) => word.length >= 3))];
}

export const repositoryLaunchContextProvider: LaunchContextProvider = {
  id: "repository-commits",
  collect: async ({ prompt, theaterId, signal }) => {
    const response = await fetch("/plugins/repository/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, limit: LOG_LIMIT, skip: 0, order: "date" }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return [];
    const data = await response.json() as LogResult;
    const words = promptWords(prompt);
    const related = data.commits.filter((commit) => {
      const subject = commit.subject.toLowerCase();
      return words.some((word) => subject.includes(word));
    });
    const picked = (related.length > 0 ? related : data.commits.slice(0, RECENT_FALLBACK)).slice(0, MAX_CANDIDATES);
    return picked.map((commit): LaunchContextCandidate => ({
      id: commit.fullHash,
      kind: "commit",
      title: `${commit.shortHash} ${commit.subject}`,
      detail: `${commit.authorName} · ${commit.relTime}`,
      text: `${commit.shortHash} ${commit.subject} (${commit.authorName}, ${commit.relTime})`,
    }));
  },
};
