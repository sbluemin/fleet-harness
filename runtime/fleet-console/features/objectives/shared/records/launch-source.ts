/** 실행 출처는 삭제·전사·모델 변경 권한에 쓰인다. 디스크에는 플러그인 시대의 소유 키를 남기지 않는다. */
export type ObjectiveLaunchSource =
  | { readonly kind: "feature"; readonly featureId: string }
  | { readonly kind: "objectiveRecord"; readonly objectiveId: string };

/** 현재 출처와 직전 저장 형식의 출처만 해석한다. 모르는 출처에는 권한을 부여하지 않는다. */
export function readObjectiveLaunchSource(value: unknown): ObjectiveLaunchSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const featureId = source.kind === "feature" ? source.featureId : source.kind === "plugin" ? source.pluginId : undefined;
  if (typeof featureId === "string" && featureId.length > 0) return { kind: "feature", featureId };
  const objectiveId = source.kind === "objectiveRecord" ? source.objectiveId : source.kind === "operation" ? source.operationId : undefined;
  if (typeof objectiveId === "string" && objectiveId.length > 0) return { kind: "objectiveRecord", objectiveId };
  return null;
}

export function sameObjectiveLaunchSource(left: unknown, right: unknown): boolean {
  const a = readObjectiveLaunchSource(left), b = readObjectiveLaunchSource(right);
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "feature" && b.kind === "feature" ? a.featureId === b.featureId
    : a.kind === "objectiveRecord" && b.kind === "objectiveRecord" && a.objectiveId === b.objectiveId;
}
