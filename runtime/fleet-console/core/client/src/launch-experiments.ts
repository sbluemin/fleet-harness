import type { LaunchContextCandidate, LaunchContextInput, LaunchContextProvider } from "@fleet-console/sdk/plugin";

/**
 * Quick Launch 실험 기능의 순수 도우미 — 컴포저는 상태와 화면만 갖고, 무엇을 언제 얼마나 붙이는지는
 * 여기서 정한다. 두 기능 모두 설정에서 켠 경우에만 컴포저가 이 모듈을 부른다.
 */

/** 프롬프트가 비어 있지 않으면 버튼이 선다 — 짧은 문장도 사용자가 물으면 답한다. */
export const LAUNCH_SUGGESTION_MIN_CHARS = 1;
/** 공급자 조회는 이 안에 끝나야 한다 — 느린 저장소 하나가 Enter를 붙들면 기능이 아니라 장애다. */
export const LAUNCH_CONTEXT_COLLECT_TIMEOUT_MS = 1500;
/** 후보 한 줄의 본문 상한. 프롬프트 상한(서버 400) 안에 여러 줄이 들어가야 한다. */
export const LAUNCH_CONTEXT_CANDIDATE_MAX_CHARS = 600;
export const LAUNCH_CONTEXT_MAX_CANDIDATES = 6;

/**
 * 등록된 공급자 전부에 같은 입력을 묻고, 시간 안에 답한 것만 모은다. 실패한 공급자는 조용히 빠진다 —
 * 컨텍스트는 있으면 좋은 것이지 런치의 전제가 아니다.
 */
export async function collectLaunchContext(
  providers: readonly LaunchContextProvider[],
  input: Omit<LaunchContextInput, "signal">,
  timeoutMs: number = LAUNCH_CONTEXT_COLLECT_TIMEOUT_MS,
): Promise<readonly LaunchContextCandidate[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const settled = await Promise.allSettled(providers.map((provider) =>
      provider.collect({ ...input, signal: abort.signal })));
    const seen = new Set<string>();
    const merged: LaunchContextCandidate[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const candidate of result.value) {
        const key = `${candidate.kind}:${candidate.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...candidate, text: candidate.text.slice(0, LAUNCH_CONTEXT_CANDIDATE_MAX_CHARS) });
        if (merged.length >= LAUNCH_CONTEXT_MAX_CANDIDATES) return merged;
      }
    }
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 체크된 후보를 프롬프트 뒤에 접힌 블록으로 붙인다. 상한을 넘기는 순간부터는 뒤의 후보를 버린다 —
 * 서버가 400으로 거절할 프롬프트를 만들지 않는다. 블록은 transcript에 그대로 남아 무엇을 근거로
 * 시작했는지 사후에 읽힌다.
 */
export function appendLaunchContext(
  prompt: string,
  candidates: readonly LaunchContextCandidate[],
  maxChars: number,
): string {
  if (candidates.length === 0) return prompt;
  const header = "\n\n<launch-context>\n";
  const footer = "\n</launch-context>";
  let body = "";
  for (const candidate of candidates) {
    const line = `## [${candidate.kind}] ${candidate.title}\n${candidate.text.trim()}\n\n`;
    if (prompt.length + header.length + body.length + line.length + footer.length > maxChars) break;
    body += line;
  }
  if (body.length === 0) return prompt;
  return `${prompt}${header}${body.trimEnd()}${footer}`;
}
