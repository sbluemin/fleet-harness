/**
 * 해석된 Codex workspace — 카탈로그 열과 복원된 확대 표면이 알아내고, 문서 열도 함께 읽는다.
 *
 * 열이 갈라지기 전에는 카탈로그 컴포넌트가 이 값을 소유해도 됐다. 이제 소비자가 셋이라
 * 어느 한 컴포넌트의 파일에 두면 그 파일이 다른 둘의 의존이 되고, 페인 id를 되돌려받는
 * 순환이 생긴다 — 공유 사실은 공유 자리에 둔다.
 */
export interface CodexWorkspaceState {
  readonly contextKey: string;
  /** 주소·파일 참조의 Theater와 Wiki 소유 스코프를 분리한다. */
  readonly theaterId?: string | null;
  readonly hasWiki: boolean;
  readonly id: string | null;
}

let lastCodexContextKey: string | null = null;
let lastResolvedWorkspace: CodexWorkspaceState | null = null;
const workspaceListeners = new Set<() => void>();
const removedWorkspaces = new Set<string>();
export function forgetCodexWorkspace(id: string): void {
  removedWorkspaces.add(id);
  if (lastResolvedWorkspace?.id === id) {
    if (lastCodexContextKey === lastResolvedWorkspace.contextKey) lastCodexContextKey = null;
    lastResolvedWorkspace = null;
    for (const listener of workspaceListeners) listener();
  }
}

export function publishResolvedWorkspace(next: CodexWorkspaceState): void {
  if (next.id && removedWorkspaces.has(next.id)) return;
  lastResolvedWorkspace = next;
  for (const listener of workspaceListeners) listener();
}

/**
 * Wiki 소유 스코프 — 위키는 사령관의 것이라 사령관 UUID 가 곧 키다. 사령관이 없으면 빈 키(위키 없음)다.
 * Theater 에서 주인을 찾지 않는다: 같은 폴더를 여러 사령관이 함께 쓸 수 있다.
 */
export function codexWorkspaceContextKey(commodoreId: string | null | undefined): string {
  return commodoreId ?? "";
}

/**
 * 덱(확대 시트)이 리더 fetch에 쓸 codex workspace id — Theater id가 아니라
 * 레일 패널이 해석해 둔 사령관 id여야 /console/codex/c/ 라우터가 인식한다.
 *
 * 공유 링크로 곧장 들어오면 그 해석이 아직 진행 중이라 여기서 null이 나온다. 그때
 * Theater id로 대신 요청하면 라우터가 workspace_not_found로 거절하고, 해석이 끝나도
 * 아무도 다시 부르지 않아 리더가 에러 화면에 머문다 — 그래서 해석 결과는 구독 가능한
 * 값이어야 하고, 소비자는 null인 동안 마운트를 미뤄야 한다.
 */
export function resolvedCodexWorkspaceIdFor(commodoreId: string | null | undefined): string | null {
  const contextKey = codexWorkspaceContextKey(commodoreId);
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
 * 마지막으로 본 Wiki 소유 스코프. "아직 모른다"(빈 문자열)에서 실제 소유자로 가는 것은
 * 바뀐 것이 아니라 **정해진 것**이다 — 그것을 변경으로 읽으면 주소가 막 열어 둔 문서를
 * 부팅 도중에 닫아 버린다.
 */
export function lastCodexScope(): string | null {
  return lastCodexContextKey;
}

export function rememberCodexScope(contextKey: string): void {
  lastCodexContextKey = contextKey;
}

/** 카탈로그를 열지 않고 복귀한 확대 표면도 같은 workspace 해석을 쓴다. 사령관 UUID 로만 묻고, 사령관이 없으면 위키도 없다. */
export async function resolveCodexWorkspace(commodoreId: string | null | undefined): Promise<Pick<CodexWorkspaceState, "hasWiki" | "id">> {
  if (!commodoreId) return { hasWiki: false, id: null };
  const response = await fetch("/api/v1/codex/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commodoreId }),
  });
  if (!response.ok) throw new Error("codex_workspace_unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_codex_workspace");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || typeof payload.hasWiki !== "boolean") throw new Error("invalid_codex_workspace");
  if (payload.hasWiki && typeof payload.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.id)) {
    return { hasWiki: true, id: payload.id };
  }
  if (!payload.hasWiki && payload.id === null) return { hasWiki: false, id: null };
  throw new Error("invalid_codex_workspace");
}
