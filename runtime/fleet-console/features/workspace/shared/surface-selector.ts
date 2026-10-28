/** 화면 요청의 루트 selector. 목표 문맥이면 objectiveId만, 아니면 theaterId와 아는 경우 소유 사령관. 절대 경로는 싣지 않는다. */
export type SurfaceSelector = { readonly objectiveId: string; readonly commodoreId?: string } | { readonly theaterId: string; readonly commodoreId?: string };

export function surfaceSelector(input: {
  readonly objectiveId?: string | null;
  readonly theaterId?: string | null;
  readonly commodoreId?: string | null;
  readonly params?: { readonly objectiveId?: string; readonly commodoreId?: string };
}): SurfaceSelector | null {
  const objectiveId = input.objectiveId || input.params?.objectiveId;
  const commodoreId = input.commodoreId ?? input.params?.commodoreId ?? null;
  const owner = commodoreId ? { commodoreId } : {};
  if (objectiveId) return { objectiveId, ...owner };
  if (input.theaterId) return { theaterId: input.theaterId, ...owner };
  return null;
}

export function surfaceSelectorQuery(selector: SurfaceSelector): string {
  const owner = selector.commodoreId ? `&commodoreId=${encodeURIComponent(selector.commodoreId)}` : "";
  return "objectiveId" in selector
    ? `objectiveId=${encodeURIComponent(selector.objectiveId)}${owner}`
    : `theaterId=${encodeURIComponent(selector.theaterId)}${owner}`;
}
