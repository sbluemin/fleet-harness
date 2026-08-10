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
export const QUICK_LAUNCH_DEFAULT_MODEL = "opus[1m]";

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
 * Canvas/Quick Launch 메뉴의 Opus/Fable 행은 Claude Code의 1M 좌표를 쓴다. 업그레이드 전
 * 저장된 bare native selection은 같은 행으로 이어 붙인다 — 브라우저 코드는 fleet-admiral를 끌어올 수
 * 없어 서버의 resolveNativeClaudeModelAlias와 같은 작은 정규화만 복제한다.
 */
function normalizeRememberedNativeModel(model: string): string {
  if (model === "opus") return "opus[1m]";
  if (model === "fable") return "fable[1m]";
  return model;
}

/**
 * 기억해 둔 조합을 현재 카탈로그에 비추어 되살린다. 처음 열었거나 기억이 낡았으면 native Opus를
 * 기본으로 삼고, 그 행조차 없을 때만 ★행과 첫 행 순서로 물러난다 — 사용자가 Gateway 기본 모델을
 * 바꿔도 Quick Launch의 첫 모델이 함께 흔들리지 않으며, 낡은 조합을 보내 생기는 409도 막는다.
 */
export function resolveSelection(
  groups: readonly OperationLaunchVariantGroup[],
  remembered: { readonly model: string | null; readonly effort: string | null },
): ResolvedSelection {
  const rows = groups.flatMap((group) => group.rows);
  const rememberedModel = remembered.model === null
    ? null
    : normalizeRememberedNativeModel(remembered.model);
  const rememberedRow = rememberedModel === null
    ? undefined
    : rows.find((row) => row.launch.model === rememberedModel);
  const row = rememberedRow
    ?? rows.find((candidate) => candidate.launch.model === QUICK_LAUNCH_DEFAULT_MODEL)
    ?? rows.find((candidate) => candidate.starred)
    ?? rows[0];
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

/**
 * 서버가 붙인 거절 코드를 사용자에게 보일 문구 키로 옮긴다. 모르는 코드는 일반 문구로 떨어뜨려
 * 아무 말도 못 하는 상태를 만들지 않는다.
 */
export function quickLaunchErrorMessageKey(code: string | null, shortenByChars: number | null = null): string | null {
  if (code === null) return null;
  // 서버가 줄여야 할 글자 수를 실어 보냈을 때만 그 수를 담는 문구를 쓴다. 브라우저는 이 실행의
  // 명령줄 상한을 알 수 없어 스스로 계산할 수 없으므로, 값이 없으면 수 없는 문구로 떨어진다.
  if (code === "prompt_command_line_too_long" && shortenByChars !== null) {
    return "chrome.quickLaunch.errorCommandLineTooLongBy";
  }
  switch (code) {
    case "prompt_unsafe_for_shim": return "chrome.quickLaunch.errorUnsafePrompt";
    case "prompt_unsupported_launch": return "chrome.quickLaunch.errorPromptUnsupported";
    case "prompt_too_long": return "chrome.quickLaunch.errorTooLong";
    case "prompt_command_line_too_long": return "chrome.quickLaunch.errorCommandLineTooLong";
    case "launch_command_line_too_long": return "chrome.quickLaunch.errorLaunchCommandLineTooLong";
    case "gateway_model_not_enabled": return "chrome.quickLaunch.errorModelOff";
    case "invalid_effort": return "chrome.quickLaunch.errorEffortOff";
    case "agent_cli_unavailable": return "chrome.quickLaunch.errorCliUnavailable";
    default: return "chrome.quickLaunch.errorGeneric";
  }
}
