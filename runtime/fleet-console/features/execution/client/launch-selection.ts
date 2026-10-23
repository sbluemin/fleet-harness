import type { ObjectiveCatalogPlugin, ObjectiveLaunchKind, ObjectiveLaunchVariantGroup, ObjectiveLaunchVariantRow } from "../../objectives/shared/records/types.js";
import { canonicalModelId } from "../../ai-gateway/shared/models.js";

/**
 * 새 세션 실행의 순수 선택 로직 — 데스크톱 새 세션 화면과 모바일 새 세션 시트가 함께 쓴다.
 *
 * 컴포넌트에서 떼어 둔다 — 컴포넌트는 feature 레지스트리(feature-registry)를 끌어오므로, 여기 남겨야 단위 테스트가
 * 번들러 가상 모듈 없이 돈다.
 */

/**
 * 서버가 강제하는 프롬프트 상한(agent-runtime `MAX_LAUNCH_PROMPT_CHARS`)의 브라우저 사본.
 *
 * 브라우저 코드는 Node 패키지를 끌어올 수 없어 값을 복제한다. 두 값이 갈라지면 컴포저가
 * 서버가 반드시 400으로 거절할 요청을 보내고 초안을 잃는다.
 */
export const LAUNCH_PROMPT_MAX_CHARS = 16000;
export const LAUNCH_DEFAULT_MODEL = "opus[1m]";

export interface VariantKindTarget {
  readonly pluginId: string | null;
  readonly kind: ObjectiveLaunchKind;
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
export function findVariantLaunchKind(catalog: readonly ObjectiveCatalogPlugin[]): VariantKindTarget | null {
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
 * 기억해 둔 조합을 현재 카탈로그에 비추어 되살린다. 처음 열었거나 기억이 낡았으면 native Opus를
 * 기본으로 삼고, 그 행조차 없을 때만 ★행과 첫 행 순서로 물러난다 — 사용자가 Gateway 기본 모델을
 * 바꿔도 새 세션의 첫 모델이 함께 흔들리지 않으며, 낡은 조합을 보내 생기는 409도 막는다.
 * 기억한 native 좌표는 가족당 `[1m]` 한 행으로 찾는다.
 */
export function resolveSelection(
  groups: readonly ObjectiveLaunchVariantGroup[],
  remembered: { readonly model: string | null; readonly effort: string | null },
): ResolvedSelection {
  const rows = groups.flatMap((group) => group.rows);
  const rememberedModel = canonicalLaunchModel(remembered.model);
  const rememberedRow = rememberedModel === null
    ? undefined
    : rows.find((row) => row.launch.model === rememberedModel);
  const row = rememberedRow
    ?? rows.find((candidate) => candidate.launch.model === LAUNCH_DEFAULT_MODEL)
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
 * 기억한 모델만 정준 실행 id로 접는다. scoped·게이트웨이 표기는 SDK `canonicalModelId`가 맡고,
 * 네 가족 bare는 메뉴 좌표(`[1m]`)로 잇는다. 브라우저 번들은 agent-runtime을 끌어오지 못한다.
 * `canonicalModelId`가 bare를 이미 `[1m]`로 돌려주면 이 표는 그대로 통과한다.
 */
export function canonicalLaunchModel(model: string | null): string | null {
  if (model === null) return null;
  const canonical = canonicalModelId(model);
  if (canonical === "opus") return "opus[1m]";
  if (canonical === "fable") return "fable[1m]";
  if (canonical === "sonnet") return "sonnet[1m]";
  if (canonical === "haiku") return "haiku[1m]";
  return canonical;
}

export interface EffortDeckOption {
  readonly id: string | null;
  readonly label: string;
  readonly checked: boolean;
  /**
   * 게이트 뒤 티어인가. 색 채널을 가르는 데 쓴다 — 트랙과 같은 계약으로, 게이트 없는 모델의
   * 최고 단(max)은 같은 단 이름이라도 이글거리지 않고 정적 글로우에 머문다.
   */
  readonly apex: boolean;
}

export interface EffortDeck {
  readonly options: readonly EffortDeckOption[];
  /** 이 모델이 게이트 뒤 티어를 내놓는가 — 문 행을 세울지 가른다. */
  readonly hasGate: boolean;
  /** 게이트가 열려 있는가. 열려 있으면 문 행은 접힘 행이 된다. */
  readonly gateOpen: boolean;
  /**
   * 지금 고른 값 자체가 게이트 단이라 게이트가 닫힐 수 없는 상태. 이때 문 행은 서지 않는다 —
   * 접어도 접히지 않는 컨트롤이 되고, 트랙처럼 "접으면 일상 단으로 내려" 해결하면 접힘 클릭이
   * 실행 강도를 조용히 바꾸는 부작용이 된다(트랙은 손잡이가 눈앞에서 움직여 그 대가를 보여준다).
   */
  readonly gateHeldByValue: boolean;
  /**
   * 문 행을 세울지. 질의를 치는 동안에는 서지 않는다 — 문 행이 남으면 매치 0인 질의에서도 덱이
   * 비지 않아, "일치 없으면 Enter는 문장을 그대로 보낸다"는 커맨드 덱 공통 계약이 이 레벨에서만
   * 깨진다(`/effort zebra`가 제출 대신 게이트를 여닫는다). 질의 중에는 접두 타이핑 게이트가
   * 이미 같은 문을 맡고 있고, 좁힌 목록 위의 "펼치기"는 필터와도 모순된다.
   */
  readonly showGateRow: boolean;
  /**
   * 문 행이 말할 단들의 이름. 문 행을 세우는 판정(`hasGate`)과 **같은 원천**에서 나온다 —
   * 이 덱은 chips에 실린 단만 행으로 내므로, 축에만 오른 단까지 세는 트랙의 사다리 기준을
   * 빌려 오면 열리지 않는 단을 이름에 싣는다. 두 표면은 여는 것이 서로 다르고, 그래서 이름도
   * 각자 자기가 열 것에서 뽑는다(트랙 쪽은 `gatedEffortNames`).
   */
  readonly gatedNames: string;
}

/**
 * `/effort` 값 목록. EffortTrack의 apex 게이트를 미러링한다 — 게이트된 단(MAX·ULTRACODE)은
 * 기본 목록에 서지 않고, 덱 맨 아래 문 행(트랙의 ✦ 토글에 상응)을 열거나 그 단의 이름을
 * 앞에서부터 명시적으로 타이핑했을 때만 나타난다. 현재 값이 이미 게이트된 단이면 트랙이
 * 게이트를 열어 두는 것과 같이 전부 보인다. 타이핑 경로를 includes가 아니라 startsWith로
 * 가르는 이유: "l" 같은 우연한 부분 일치가 고비용 단을 조용히 드러내면 게이트가 없는 것과 같다.
 *
 * 문 행은 트랙의 ✦이 없는 모델에서 서지 않는다 — 그래야 "이 모델엔 그 단이 없다"와
 * "있는데 접혀 있다"가 처음으로 갈린다. 두 상태가 같은 5행으로 보이던 것이 이 덱의 결함이었다.
 */
export function buildEffortDeck(
  row: ObjectiveLaunchVariantRow | null,
  effort: string | null,
  autoLabel: string,
  query: string,
  opened: boolean,
): EffortDeck {
  const trimmed = query.trim().toLowerCase();
  const gated = new Set(row?.gatedEfforts ?? []);
  // 모델이 축에만 올리고 실제로 내놓지 않은 게이트 단은 문을 열어도 고를 것이 없다 —
  // chips에 실린 것만 게이트가 있다고 센다(트랙의 ✦ 출현 조건과 같다).
  const offeredGated = (row?.chips ?? []).filter((chip) => gated.has(chip.id));
  const hasGate = offeredGated.length > 0;
  const gateHeldByValue = hasGate && effort !== null && gated.has(effort);
  const gateOpen = hasGate && (opened || gateHeldByValue);
  const options = [
    { id: null as string | null, label: autoLabel },
    ...(row?.chips ?? []).map((chip) => ({ id: chip.id as string | null, label: chip.label })),
  ]
    .filter((chip) => {
      const label = chip.label.toLowerCase();
      const id = (chip.id ?? "").toLowerCase();
      if (trimmed.length > 0 && !label.includes(trimmed) && !id.includes(trimmed)) return false;
      if (chip.id === null || !gated.has(chip.id)) return true;
      if (gateOpen) return true;
      return trimmed.length > 0 && (label.startsWith(trimmed) || id.startsWith(trimmed));
    })
    .map((chip) => ({
      id: chip.id,
      label: chip.label,
      checked: chip.id === effort,
      apex: chip.id !== null && gated.has(chip.id),
    }));
  return {
    options,
    hasGate,
    gateOpen,
    gateHeldByValue,
    showGateRow: hasGate && !gateHeldByValue && trimmed.length === 0,
    gatedNames: offeredGated.map((chip) => chip.label).join("·"),
  };
}

/**
 * 서버가 붙인 거절 코드를 사용자에게 보일 문구 키로 옮긴다. 모르는 코드는 일반 문구로 떨어뜨려
 * 아무 말도 못 하는 상태를 만들지 않는다.
 */
export function launchErrorMessageKey(code: string | null, shortenByChars: number | null = null): string | null {
  if (code === null) return null;
  // 서버가 줄여야 할 글자 수를 실어 보냈을 때만 그 수를 담는 문구를 쓴다. 브라우저는 이 실행의
  // 명령줄 상한을 알 수 없어 스스로 계산할 수 없으므로, 값이 없으면 수 없는 문구로 떨어진다.
  if (code === "prompt_command_line_too_long" && shortenByChars !== null) {
    return "chrome.launch.errorCommandLineTooLongBy";
  }
  switch (code) {
    case "prompt_unsafe_for_shim": return "chrome.launch.errorUnsafePrompt";
    case "prompt_unsupported_launch": return "chrome.launch.errorPromptUnsupported";
    case "prompt_too_long": return "chrome.launch.errorTooLong";
    case "prompt_command_line_too_long": return "chrome.launch.errorCommandLineTooLong";
    case "launch_command_line_too_long": return "chrome.launch.errorLaunchCommandLineTooLong";
    case "gateway_model_not_enabled": return "chrome.launch.errorModelOff";
    case "invalid_effort": return "chrome.launch.errorEffortOff";
    case "agent_cli_not_installed": return "chrome.launch.errorCliNotInstalled";
    case "agent_cli_signed_out": return "chrome.launch.errorCliSignedOut";
    // preflight를 통과한 뒤 spawn 단계에서 죽은 경우 — 설정된 실행 파일 자체의 문제다.
    case "agent_cli_binary_missing": return "chrome.launch.errorCliBinaryMissing";
    case "agent_cli_not_executable": return "chrome.launch.errorCliNotExecutable";
    // 옛 서버는 두 원인을 이 하나로 보냈다. 그 조합에서도 문장이 나와야 하므로 어휘를 남긴다.
    case "agent_cli_unavailable": return "chrome.launch.errorCliUnavailable";
    // 만료된 업로드 토큰은 첨부 스토어가 칩을 걷고 composerT로 말한다. 여기 두면 같은 말이 두 벌이 된다.
    case "attachment_not_found": return null;
    case "attachment_limit": return "chrome.launch.errorAttachmentLimit";
    default: return "chrome.launch.errorGeneric";
  }
}
