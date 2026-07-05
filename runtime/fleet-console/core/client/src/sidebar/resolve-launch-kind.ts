import type { OperationCatalogPlugin, OperationLaunchKind, OperationNode } from "@fleet-console/sdk/operations";

type LaunchKindOperation = Pick<OperationNode, "pluginId" | "type" | "payload">;

export function resolveOperationLaunchKind(catalog: readonly OperationCatalogPlugin[], operation: LaunchKindOperation): OperationLaunchKind | null {
  const candidates = catalog
    .find((plugin) => plugin.id === operation.pluginId)
    ?.kinds.filter((kind) => kind.type === operation.type) ?? [];
  const launchKindId = operation.payload.launchKindId;
  if (typeof launchKindId === "string") {
    const matchingKind = candidates.find((kind) => kind.id === launchKindId);
    if (matchingKind) return matchingKind;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
