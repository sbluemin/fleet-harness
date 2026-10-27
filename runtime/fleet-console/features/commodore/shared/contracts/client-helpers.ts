/**
 * 질문이 가리킨 목표의 제목 — 살아 있는 보드(목표 상태)를 먼저 읽어 질문이 선 뒤의 새 목표·이름 변경·제거를 바로 따른다.
 * 그 Theater 의 보드를 아직 읽지 않았으면 서버가 상태 뷰와 함께 준 제목으로 대신한다. 보드에서 사라졌으면 null.
 */
export function askObjectiveTitle(board: { readonly loaded: boolean; readonly objectives: readonly { readonly id: string; readonly title: string; readonly removed?: unknown }[] }, served: Readonly<Record<string, { readonly title: string } | null>> | undefined, objectiveId: string): string | null {
  if (!board.loaded) return served?.[objectiveId]?.title ?? null;
  const live = board.objectives.find((objective) => objective.id === objectiveId);
  return live && !live.removed ? live.title : null;
}
