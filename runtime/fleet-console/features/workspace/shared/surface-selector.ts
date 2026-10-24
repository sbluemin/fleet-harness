/** 화면 요청의 루트 selector. 목표 문맥이면 objectiveId만, 아니면 theaterId만. 절대 경로는 싣지 않는다. */
export type SurfaceSelector = { readonly objectiveId: string } | { readonly theaterId: string };

export function surfaceSelector(input: {
  readonly objectiveId?: string | null;
  readonly theaterId?: string | null;
  readonly params?: { readonly objectiveId?: string };
  readonly conversation?: { readonly objectiveId?: string } | null;
}): SurfaceSelector | null {
  const objectiveId = input.objectiveId || input.params?.objectiveId || input.conversation?.objectiveId;
  if (objectiveId) return { objectiveId };
  if (input.theaterId) return { theaterId: input.theaterId };
  return null;
}

export function surfaceSelectorQuery(selector: SurfaceSelector): string {
  return "objectiveId" in selector
    ? `objectiveId=${encodeURIComponent(selector.objectiveId)}`
    : `theaterId=${encodeURIComponent(selector.theaterId)}`;
}
