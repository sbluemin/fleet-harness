/**
 * 질문이 가리킨 목표의 제목 — 살아 있는 보드(목표 상태)를 먼저 읽어 질문이 선 뒤의 새 목표·이름 변경·제거를 바로 따른다.
 * 그 Theater 의 보드를 아직 읽지 않았으면 서버가 상태 뷰와 함께 준 제목으로 대신한다. 보드에서 사라졌으면 null.
 */
export function askObjectiveTitle(board: { readonly loaded: boolean; readonly objectives: readonly { readonly id: string; readonly title: string; readonly removed?: unknown }[] }, served: Readonly<Record<string, { readonly title: string } | null>> | undefined, objectiveId: string): string | null {
  if (!board.loaded) return served?.[objectiveId]?.title ?? null;
  const live = board.objectives.find((objective) => objective.id === objectiveId);
  return live && !live.removed ? live.title : null;
}

/** 화면에서 선택한 장소의 소유 UUID를 새 생성 요청에 명시한다. 목표를 읽을 때는 사용하지 않는다. */
export async function resolveOwnerForContext(theaterId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/v1/commodore/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId }), signal });
  const body = await response.json() as { commodoreId?: unknown; error?: unknown };
  if (!response.ok || typeof body.commodoreId !== "string" || !body.commodoreId) throw new Error("commodore_unavailable");
  return body.commodoreId;
}
