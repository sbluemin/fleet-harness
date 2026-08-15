import type { ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

import { launchProviderFromOperationPayload, launchProviderGlyph, type LaunchProviderGlyphId } from "./components/launch-provider-glyphs.js";
import { resolveOperationLaunchKind } from "./sidebar/interaction.js";
import type { OperationNode } from "./types.js";

export interface OperationMark {
  readonly icon: ReactNode;
  readonly launchProvider: LaunchProviderGlyphId | null;
}

/**
 * 칩·커맨드 밴드·팔레트·War Room 카드가 쓸 마크. 실행된 공급자가 기록된 Operation은 그
 * 공급자의 글리프가 실행 종류 아이콘을 대신한다 — 같은 실행 종류라도 어느 공급자의 모델이
 * 돌았는지가 목록에서 먼저 읽혀야 한다. 공급자를 기록하지 않는 플러그인은 그대로 자기
 * 아이콘을 그린다.
 */
export function resolveOperationMark(
  operation: OperationNode,
  catalog: readonly OperationCatalogPlugin[],
  renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode,
): OperationMark {
  const launchProvider = launchProviderFromOperationPayload(operation.payload);
  if (launchProvider) return { icon: launchProviderGlyph(launchProvider), launchProvider };
  const kind = resolveOperationLaunchKind(catalog, operation);
  return { icon: kind ? renderKindIcon(operation.pluginId, kind) : null, launchProvider: null };
}
