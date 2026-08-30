/**
 * 해석된 Codex workspace — 카탈로그 열이 알아내고, 문서 열과 읽기 시트가 함께 읽는다.
 *
 * 열이 갈라지기 전에는 카탈로그 컴포넌트가 이 값을 소유해도 됐다. 이제 소비자가 셋이라
 * 어느 한 컴포넌트의 파일에 두면 그 파일이 다른 둘의 의존이 되고, 페인 id를 되돌려받는
 * 순환이 생긴다 — 공유 사실은 공유 자리에 둔다.
 */
export interface CodexWorkspaceState {
  readonly contextKey: string;
  readonly hasWiki: boolean;
  readonly id: string | null;
}

let lastCodexContextKey: string | null = null;
let lastResolvedWorkspace: CodexWorkspaceState | null = null;
const workspaceListeners = new Set<() => void>();

export function publishResolvedWorkspace(next: CodexWorkspaceState): void {
  lastResolvedWorkspace = next;
  for (const listener of workspaceListeners) listener();
}

/**
 * 덱(확대 시트)이 리더 fetch에 쓸 codex workspace id — Theater id가 아니라
 * 레일 패널이 해석해 둔 12-hex id여야 /console/codex/w/ 라우터가 인식한다.
 *
 * 공유 링크로 곧장 들어오면 그 해석이 아직 진행 중이라 여기서 null이 나온다. 그때
 * Theater id로 대신 요청하면 라우터가 workspace_not_found로 거절하고, 해석이 끝나도
 * 아무도 다시 부르지 않아 리더가 에러 화면에 머문다 — 그래서 해석 결과는 구독 가능한
 * 값이어야 하고, 소비자는 null인 동안 마운트를 미뤄야 한다.
 */
export function resolvedCodexWorkspaceIdFor(theaterId: string | null): string | null {
  const contextKey = theaterId ?? "";
  if (lastResolvedWorkspace && lastResolvedWorkspace.contextKey === contextKey && lastResolvedWorkspace.hasWiki) {
    return lastResolvedWorkspace.id;
  }
  return null;
}

export function subscribeCodexWorkspace(listener: () => void): () => void {
  workspaceListeners.add(listener);
  return () => workspaceListeners.delete(listener);
}


/** 마지막으로 해석된 사실 — 카탈로그 열이 초기 상태를 여기서 집는다. */
export function lastResolvedCodexWorkspace(): CodexWorkspaceState | null {
  return lastResolvedWorkspace;
}

/**
 * 마지막으로 본 Theater 스코프. "아직 모른다"(빈 문자열)에서 실제 Theater로 가는 것은
 * 바뀐 것이 아니라 **정해진 것**이다 — 그것을 변경으로 읽으면 주소가 막 열어 둔 문서를
 * 부팅 도중에 닫아 버린다.
 */
export function lastCodexScope(): string | null {
  return lastCodexContextKey;
}

export function rememberCodexScope(contextKey: string): void {
  lastCodexContextKey = contextKey;
}
