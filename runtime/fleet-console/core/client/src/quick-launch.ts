import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

/**
 * Quick Launch 컴포저의 순수 선택 로직.
 *
 * 컴포넌트에서 분리해 둔다 — operation-search.ts / components/operation-search.tsx와 같은 갈래다.
 * 컴포넌트는 플러그인 레지스트리(virtual:fleet-plugins)를 끌어오므로, 여기 남겨야 단위 테스트가
 * 번들러 가상 모듈 없이 돈다.
 */

/**
 * 서버가 강제하는 프롬프트 상한(fleet-admiral `MAX_LAUNCH_PROMPT_CHARS`)의 브라우저 사본.
 *
 * 브라우저 코드는 Node 패키지를 끌어올 수 없어 값을 복제한다. 두 값이 갈라지면 컴포저가
 * 서버가 반드시 400으로 거절할 요청을 보내고 초안을 잃으므로, `tests/quick-launch.test.ts`가
 * 실제 서버 상수와의 일치를 못 박는다.
 */
export const QUICK_LAUNCH_PROMPT_MAX_CHARS = 16000;

export interface VariantKindTarget {
  readonly pluginId: string;
  readonly kind: OperationLaunchKind;
}

export interface ResolvedSelection {
  readonly model: string | null;
  readonly effort: string | null;
  readonly modelLabel: string | null;
  readonly effortLabel: string | null;
}

/**
 * 모델·강도 조합을 제공하는 실행 종류를 카탈로그에서 고른다.
 *
 * 플러그인 id를 박아 넣지 않는다 — console-core는 어느 플러그인이 Claude Gateway인지 몰라야 하고,
 * "모델·강도 변형을 선언한 실행 종류"라는 능력만으로 충분히 특정된다(캔버스 우클릭 메뉴가 플라이아웃을
 * 띄우는 기준과 같은 조건).
 */
export function findVariantLaunchKind(catalog: readonly OperationCatalogPlugin[]): VariantKindTarget | null {
  for (const plugin of catalog) {
    for (const kind of plugin.kinds) {
      if (kind.disabled) continue;
      if (!kind.variants || kind.variants.length === 0) continue;
      return { pluginId: plugin.id, kind };
    }
  }
  return null;
}

/**
 * 기억해 둔 조합을 현재 카탈로그에 비추어 되살린다. 설정에서 모델을 끄거나 강도 사다리가 좁아지면
 * 기억은 낡은 값이 되므로, 여기서 걸러 ★기본 행으로 되돌린다 — 낡은 조합을 그대로 보내면 서버가
 * 409 gateway_model_not_enabled로 거절한다.
 */
export function resolveSelection(
  groups: readonly OperationLaunchVariantGroup[],
  remembered: { readonly model: string | null; readonly effort: string | null },
): ResolvedSelection {
  const rows = groups.flatMap((group) => group.rows);
  const rememberedRow = remembered.model === null
    ? undefined
    : rows.find((row) => row.launch.model === remembered.model);
  const row = rememberedRow ?? rows.find((candidate) => candidate.starred) ?? rows[0];
  if (!row) return { model: null, effort: null, modelLabel: null, effortLabel: null };
  const chip = rememberedRow && remembered.effort !== null
    ? row.chips?.find((candidate) => candidate.launch.effort === remembered.effort)
    : undefined;
  return {
    model: row.launch.model ?? null,
    effort: chip?.launch.effort ?? null,
    modelLabel: row.label,
    effortLabel: chip?.label ?? null,
  };
}
