import type { ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchVariantGroup, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import type { MentionTargetDescriptor } from "@fleet-console/sdk/plugin";
import type { OperationActivityVisual } from "./operation-activity.js";

import { buildOperationSearchEntries, filterOperationSearchEntries, groupOperationSearchEntries, searchTokens, type OperationSearchEntry, type OperationSearchGroup } from "./operation-search.js";
import type { ConsoleState } from "./types.js";

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

/**
 * 이미지 첨부 정책은 컴포저 블록 패키지가 소유한다 — Quick Launch와 채팅 컴포저가 같은 입구를
 * 같은 규칙으로 열어야 한쪽에서 되는 붙여넣기가 다른 쪽에서 조용히 사라지지 않는다. 이 이름들은
 * 기존 호출부를 위한 별칭이고, 정의는 sdk/composer/attachments.ts 한 곳에 있다.
 */
export {
  COMPOSER_ATTACHMENT_MAX_BYTES as QUICK_LAUNCH_ATTACHMENT_MAX_BYTES,
  COMPOSER_MAX_ATTACHMENTS as QUICK_LAUNCH_MAX_ATTACHMENTS,
  isComposerAttachmentCandidate as isQuickLaunchAttachmentCandidate,
} from "@fleet-console/sdk/composer";

/**
 * 업로드 거절 코드를 문구 키로 옮긴다. 모르는 코드·네트워크 실패는 일반 업로드 실패 문구로
 * 떨어뜨려 아무 말도 못 하는 상태를 만들지 않는다.
 */
export function quickLaunchAttachmentErrorMessageKey(code: string | null): string {
  switch (code) {
    case "attachment_too_large": return "chrome.quickLaunch.errorAttachmentTooLarge";
    case "attachment_unsupported": return "chrome.quickLaunch.errorAttachmentUnsupported";
    case "attachment_limit": return "chrome.quickLaunch.errorAttachmentLimit";
    // 미발사 총량 상한 — "다시 붙여넣으라"는 일반 문구로 떨어뜨리면 재시도가 같은 벽에 반복해 부딪힌다.
    case "attachment_storage_exhausted": return "chrome.quickLaunch.errorAttachmentStorageExhausted";
    default: return "chrome.quickLaunch.errorAttachmentUploadFailed";
  }
}

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

export interface QuickLaunchMentionToken {
  readonly at: number;
  readonly query: string;
}

/**
 * caret 앞의 `@`가 문두나 공백 뒤에 있고 caret까지 공백·`@`가 섞이지 않았을 때만 멘션 토큰이다 —
 * 문장 중간의 이메일·리터럴 `@`는 목록을 깨우지 않는다.
 */
export function readMentionToken(value: string, caretIndex: number): QuickLaunchMentionToken | null {
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  const at = value.lastIndexOf("@", caret - 1);
  // lastIndexOf는 음수 fromIndex를 0으로 클램프한다 — caret이 '@' 앞이면 토큰이 아니다.
  if (at < 0 || at >= caret) return null;
  if (at > 0 && !/\s/.test(value[at - 1] ?? "")) return null;
  const query = value.slice(at + 1, caret);
  if (/[\s@]/.test(query)) return null;
  return { at, query };
}

/** 확정된 토큰(`@query`)을 입력값에서 걷어낸다 — 멘션은 텍스트가 아니라 행선지로 남는다. */
export function stripMentionToken(value: string, token: QuickLaunchMentionToken): string {
  return `${value.slice(0, token.at)}${value.slice(token.at + 1 + token.query.length)}`;
}

/** 값 레벨을 가지는 커맨드. `/pin`은 액션이라 1레벨에서 끝난다. */
export type QuickLaunchCommandId = "theater" | "model" | "effort" | "view" | "pin";
const COMMAND_VALUE_TOKENS: readonly Exclude<QuickLaunchCommandId, "pin">[] = ["theater", "model", "effort", "view"];

export type QuickLaunchCommandInput =
  | { readonly kind: "commands"; readonly query: string }
  | { readonly kind: "values"; readonly command: Exclude<QuickLaunchCommandId, "pin">; readonly query: string };

/**
 * '/' 커맨드는 프롬프트 **첫 글자**에서만 깨어난다 — '@'와 달리 `/`는 파일 경로의 첫 글자이기도
 * 해서, 단어 시작마다 깨우면 `/Users/…`를 치는 내내 덱이 명멸한다. 첫 단어 안의 두 번째 `/`나
 * 공백은 즉시 리터럴로 눕힌다('@' 토큰의 공백 해제와 같은 계약). 첫 단어가 값 커맨드 토큰과
 * 정확히 일치하고 공백이 뒤따르면 값 레벨이다 — 값 쿼리는 모델 이름처럼 공백을 품을 수 있어
 * 해제 문자를 두지 않고, 매치 없는 덱이 Enter를 막지 않는 계약이 회복을 보장한다.
 *
 * 쿼리는 caret이 아니라 문면에 앵커된다('@' 토큰과 다른 점). 커맨드는 입력 전체를 소유하고
 * 선택이 입력 전체를 갈아치우므로, caret 위치가 목록과 실행을 가르면 보이는 필터와 Enter의
 * 결과가 어긋난다 — caret은 "커맨드 영역 밖(0)"인지만 가른다.
 */
export function readCommandInput(value: string, caretIndex: number): QuickLaunchCommandInput | null {
  if (!value.startsWith("/")) return null;
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  if (caret < 1) return null;
  const boundary = value.slice(1).search(/\s/);
  const wordEnd = boundary === -1 ? value.length : boundary + 1;
  const word = value.slice(1, wordEnd);
  if (word.includes("/")) return null;
  if (boundary === -1) return { kind: "commands", query: word };
  const command = COMMAND_VALUE_TOKENS.find((token) => token === word);
  if (!command) return null;
  return { kind: "values", command, query: value.slice(wordEnd + 1) };
}

/** 프롬프트 안에서 인식된 `ultracode` 한 건의 문면 구간. */
export interface UltracodeToken {
  readonly start: number;
  readonly end: number;
}

/**
 * 대소문자를 가리지 않고, 단어 경계로만 잡는다 — `ULTRACODE`·`UltraCode`는 인식하고
 * `ultracoder`·`my-ultracode-notes`의 일부는 인식하지 않는다. `-`는 경계로 친다(식별자 문자만
 * 붙임으로 본다): 하이픈으로 이어 붙인 파일명 안의 단어까지 잡으면 프롬프트에 경로 하나만 실어도
 * 컴포저가 무장한다.
 *
 * 이 단어는 실행 좌표가 아니라 **프롬프트 원문의 일부**다. Console은 인식만 하고 문면은 손대지
 * 않는다 — 하네스가 그 단어를 어떻게 읽을지는 하네스가 정한다.
 */
export function readUltracodeTokens(value: string): readonly UltracodeToken[] {
  const pattern = /(?<![A-Za-z0-9_])ultracode(?![A-Za-z0-9_])/gi;
  const tokens: UltracodeToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * 해제(무시)는 **이 초안**에 붙는 상태다. 문면에서 단어가 전부 사라지면 해제도 함께 만료한다 —
 * 그래야 지웠다 다시 친 단어가 새 의사표시로 읽힌다. 남아 있는 동안은 문장을 계속 고쳐도
 * 다시 켜지지 않는다(한 번 껐다는 사실이 편집마다 뒤집히면 그 스위치는 못 믿는다).
 */
export function nextUltracodeIgnored(value: string, ignored: boolean): boolean {
  return ignored && readUltracodeTokens(value).length > 0;
}

/**
 * Backspace가 삭제 대신 해제를 맡는 자리: 선택이 접혀 있고 caret이 인식된 토큰의 **바로 뒤**일 때다.
 * 그 밖의 모든 Backspace는 평소대로 글자를 지운다 — 이 키의 기본 뜻을 넓게 빼앗으면 컴포저가
 * 지워지지 않는 입력이 된다.
 */
export function isUltracodeDisarmCaret(value: string, selectionStart: number, selectionEnd: number): boolean {
  if (selectionStart !== selectionEnd) return false;
  return readUltracodeTokens(value).some((token) => token.end === selectionStart);
}

export interface QuickLaunchEffortOption {
  readonly id: string | null;
  readonly label: string;
  readonly checked: boolean;
  /**
   * 게이트 뒤 티어인가. 색 채널을 가르는 데 쓴다 — 트랙과 같은 계약으로, 게이트 없는 모델의
   * 최고 단(max)은 같은 단 이름이라도 이글거리지 않고 정적 글로우에 머문다.
   */
  readonly apex: boolean;
}

export interface QuickLaunchEffortDeck {
  readonly options: readonly QuickLaunchEffortOption[];
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
export function buildQuickLaunchEffortDeck(
  row: OperationLaunchVariantRow | null,
  effort: string | null,
  autoLabel: string,
  query: string,
  opened: boolean,
): QuickLaunchEffortDeck {
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
 * awaiting은 CLI가 응답 입력을 기다리는 상태라 임의 텍스트가 프롬프트 응답을 오염시킨다 —
 * 목록에서 dim + 선택 불가 + 방향키 스킵(제품 결정). dormant는 선택 가능하며 서버가 재기동 후 전달한다.
 */
export function isMentionSelectable(activity: OperationActivityVisual): boolean {
  return activity !== "awaiting";
}

/**
 * 멘션 덱의 목록: messageOperation을 선언한 플러그인의 해당 타입 Operation만, Theater로 묶어서.
 * 활동 분류는 팔레트와 같은 원천(resolveOperationActivity)을 쓰되 idle-arrival 화면 승격은 받지
 * 않는다 — 여기서 awaiting은 선택 차단 신호라, 표시용 승격이 섞이면 보낼 수 있는 대상이 막힌다.
 */
export function buildQuickLaunchMentionGroups(
  state: ConsoleState,
  messageableTypesByPlugin: ReadonlyMap<string, ReadonlySet<string>>,
  query: string,
): readonly OperationSearchGroup[] {
  const mentionable = state.operations.filter((operation) => messageableTypesByPlugin.get(operation.pluginId)?.has(operation.type) === true);
  if (mentionable.length === 0) return [];
  const entries = buildOperationSearchEntries({ ...state, operations: mentionable });
  return groupOperationSearchEntries(filterOperationSearchEntries(entries, query));
}

/**
 * 플러그인이 기여한 비-Operation 행선지 한 줄. 호스트가 쓰는 모양으로 눕힌 것이라 descriptor를
 * 그대로 들고 다니지 않는다 — `optionId`가 이름공간을 나눈 유일한 신원이고, DOM id도 이 값이다.
 */
export interface QuickLaunchPluginMentionRow {
  readonly pluginId: string;
  readonly targetId: string;
  readonly optionId: string;
  readonly label: string;
  readonly categoryLabel: string;
  readonly capabilityLabel: string | null;
  readonly description: string | null;
  readonly renderMark: (() => ReactNode) | null;
}

/** 덱에서 한 카테고리 밴드 아래 서는 행 묶음. */
export interface QuickLaunchMentionCategory {
  readonly key: string;
  readonly label: string;
  readonly capabilityLabel: string | null;
  readonly rows: readonly QuickLaunchPluginMentionRow[];
}

/** 덱이 읽는 플러그인의 최소 모양. 컴포넌트가 레지스트리 전체를 넘기지 않아도 단위 테스트가 돈다. */
export interface QuickLaunchMentionSource {
  readonly id: string;
  readonly mentionTargets?: () => readonly MentionTargetDescriptor[];
  readonly messageMentionTarget?: (targetId: string, text: string) => Promise<void>;
}

/** 확정된 행선지. Operation과 플러그인 대상은 전달 경로도 태그도 달라서 판별 유니온으로 둔다. */
export type QuickLaunchMentionTarget =
  | { readonly kind: "operation"; readonly entry: OperationSearchEntry }
  | { readonly kind: "plugin"; readonly row: QuickLaunchPluginMentionRow };

/** 행선지의 이름 — 안내문·칩·거절 문구가 공유하는 한 값. */
export function mentionTargetName(target: QuickLaunchMentionTarget): string {
  return target.kind === "operation" ? target.entry.operationName : target.row.label;
}

/**
 * 플러그인 기여 행선지의 카테고리 목록.
 *
 * `mentionTargets`와 `messageMentionTarget`을 **함께** 선언한 플러그인만 읽는다 — 목록에만 서고
 * 받지 못하는 행선지는 고르는 순간 막다른 길이 된다(Operation 쪽 `messageOperation` 짝 조건과 같다).
 * 로스터를 읽다 던지는 플러그인은 그 플러그인만 빠지고 덱은 계속 선다.
 */
export function buildPluginMentionCategories(
  plugins: readonly QuickLaunchMentionSource[],
  query: string,
): readonly QuickLaunchMentionCategory[] {
  const tokens = searchTokens(query);
  const categories: QuickLaunchMentionCategory[] = [];
  const categoryIndexes = new Map<string, number>();
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.mentionTargets || !plugin.messageMentionTarget) continue;
    let descriptors: readonly MentionTargetDescriptor[];
    try {
      descriptors = plugin.mentionTargets();
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      if (!descriptor.id || !descriptor.label || !descriptor.categoryLabel) continue;
      const optionId = `${plugin.id}:${descriptor.id}`;
      if (seen.has(optionId)) continue;
      seen.add(optionId);
      const haystack = [descriptor.label, descriptor.categoryLabel, plugin.id].join(" ").toLocaleLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      const row: QuickLaunchPluginMentionRow = {
        pluginId: plugin.id,
        targetId: descriptor.id,
        optionId,
        label: descriptor.label,
        categoryLabel: descriptor.categoryLabel,
        capabilityLabel: descriptor.capabilityLabel ?? null,
        description: descriptor.description ?? null,
        renderMark: descriptor.renderMark ?? null,
      };
      // 카테고리는 플러그인 안에서만 묶는다 — 두 플러그인이 우연히 같은 문구를 써도 한 밴드로
      // 뭉치면 그 밴드의 주인이 사라진다.
      const key = `${plugin.id}\u0000${descriptor.categoryLabel}`;
      const index = categoryIndexes.get(key);
      if (index === undefined) {
        categoryIndexes.set(key, categories.length);
        categories.push({
          key,
          label: descriptor.categoryLabel,
          capabilityLabel: row.capabilityLabel,
          rows: [row],
        });
        continue;
      }
      const existing = categories[index]!;
      categories[index] = { ...existing, rows: [...existing.rows, row] };
    }
  }
  return categories;
}

/**
 * 보고 있는 패널이 멘션 덱에 오를 수 있을 때만 행선지가 된다. 활성 없음·셸·다른 플러그인·
 * awaiting·사라진 id는 전부 null — 덱이 고를 수 없는 것을 자동 확정도 고르지 않는다.
 *
 * "보고 있다"는 알림·브레드크럼과 같은 판정이다. Theater만 바꾸면 activeOperationId가 남고
 * (/settings·모바일 비-Operations에서는 operationsViewActive가 꺼진다) 그 id를 그대로
 * 확정하면 화면에 없는 패널로 보낸다.
 *
 * War Room 무대는 예외다. 전 Theater가 마운트되므로 지목이 Theater를 바꾸지 않고
 * (pickTriageOperation) 무대 Operation을 active로 세운다. 그 id는 leftover가 아니라
 * 지금 보고 있는 패널이다 — visibleOperationId로만 허용한다.
 */
export function resolveFocusedMention(
  state: ConsoleState,
  messageableTypesByPlugin: ReadonlyMap<string, ReadonlySet<string>>,
  visibleOperationId: string | null = null,
): OperationSearchEntry | null {
  const operationId = state.activeOperationId;
  if (!state.operationsViewActive || !operationId) return null;
  const entry = resolveMentionEntry(state, messageableTypesByPlugin, operationId);
  if (!entry) return null;
  if (entry.theaterId !== state.activeTheaterId && entry.operationId !== visibleOperationId) return null;
  return entry;
}

/**
 * Operation 하나를 멘션 행선지로 해소한다. 덱과 같은 원천을 빈 질의로 읽어 "메시지를 받는 타입인가"를
 * 확인하고, 입력 대기 중인 대상은 덱과 같은 이유로 거른다(임의 텍스트가 CLI 프롬프트 응답을 오염시킨다).
 *
 * 포커스 옵트인(resolveFocusedMention)과 명시 행선지(패널 회신 버튼이 건네는 시드)가 공유하는 판정이다 —
 * 두 진입점이 서로 다른 기준으로 대상을 고르면 같은 패널이 경로에 따라 다르게 주소된다. 두 경로의
 * 유일한 차이는 Theater 가드로, 포커스 쪽만 진다: 시드는 그 패널의 버튼을 직접 누른 지시라
 * 어느 Theater의 패널인지가 의도를 바꾸지 않는다.
 */
export function resolveMentionEntry(
  state: ConsoleState,
  messageableTypesByPlugin: ReadonlyMap<string, ReadonlySet<string>>,
  operationId: string,
): OperationSearchEntry | null {
  const entry = buildQuickLaunchMentionGroups(state, messageableTypesByPlugin, "")
    .flatMap((group) => group.entries)
    .find((candidate) => candidate.operationId === operationId);
  if (!entry || !isMentionSelectable(entry.activity)) return null;
  return entry;
}

/**
 * 옵트인이 켜져 있고 컴포저가 비어 있을 때만 포커스 멘션을 확정한다. 초안·이미 붙은 멘션·
 * 입력 중인 문면은 새 런치를 덮지 않는다. 회신 말풍선이 건네는 명시 시드는 이 가드를
 * 쓰지 않는다 — 그 버튼은 남은 초안을 이어 쓰지 않는 새 주소다.
 */
export function shouldApplyFocusedMention(input: {
  readonly prefOn: boolean;
  readonly leftoverDraft: boolean;
  readonly mentionAlreadySet: boolean;
  readonly promptOccupied: boolean;
}): boolean {
  return input.prefOn && !input.leftoverDraft && !input.mentionAlreadySet && !input.promptOccupied;
}

/**
 * 멘션 전달 거절 코드를 문구 키로 옮긴다. 런치 거절 코드와 겹치는 것은 그 문구를 재사용하고,
 * 모르는 코드는 일반 실패 문구로 떨어뜨린다.
 */
export function quickLaunchMentionErrorMessageKey(code: string | null): string {
  switch (code) {
    case "resume_unavailable": return "chrome.quickLaunch.mentionErrorResumeUnavailable";
    case "session_awaiting_input": return "chrome.quickLaunch.mentionErrorAwaiting";
    // 비-Operation 행선지가 아직 앞 질문에 답하는 중 — 조용히 삼키면 사용자의 문장이 사라진다.
    case "destination_busy": return "chrome.quickLaunch.mentionErrorBusy";
    case "session_not_found": return "chrome.quickLaunch.mentionErrorGone";
    case "prompt_too_long": return "chrome.quickLaunch.errorTooLong";
    // 첨부가 만료·소실된 전달 거절 — 칩은 남았지만 그 서버 파일은 이미 없다(런치 거절과 같은 문구).
    case "attachment_not_found": return "chrome.quickLaunch.errorAttachmentGone";
    case "attachment_limit": return "chrome.quickLaunch.errorAttachmentLimit";
    case "gateway_model_not_enabled": return "chrome.quickLaunch.errorModelOff";
    case "invalid_effort": return "chrome.quickLaunch.errorEffortOff";
    case "agent_cli_not_installed": return "chrome.quickLaunch.errorCliNotInstalled";
    case "agent_cli_signed_out": return "chrome.quickLaunch.errorCliSignedOut";
    // preflight를 통과한 뒤 spawn 단계에서 죽은 경우 — 설정된 실행 파일 자체의 문제다.
    case "agent_cli_binary_missing": return "chrome.quickLaunch.errorCliBinaryMissing";
    case "agent_cli_not_executable": return "chrome.quickLaunch.errorCliNotExecutable";
    // 옛 서버는 두 원인을 이 하나로 보냈다. 그 조합에서도 문장이 나와야 하므로 어휘를 남긴다.
    case "agent_cli_unavailable": return "chrome.quickLaunch.errorCliUnavailable";
    default: return "chrome.quickLaunch.mentionErrorDeliveryFailed";
  }
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
    case "agent_cli_not_installed": return "chrome.quickLaunch.errorCliNotInstalled";
    case "agent_cli_signed_out": return "chrome.quickLaunch.errorCliSignedOut";
    // preflight를 통과한 뒤 spawn 단계에서 죽은 경우 — 설정된 실행 파일 자체의 문제다.
    case "agent_cli_binary_missing": return "chrome.quickLaunch.errorCliBinaryMissing";
    case "agent_cli_not_executable": return "chrome.quickLaunch.errorCliNotExecutable";
    // 옛 서버는 두 원인을 이 하나로 보냈다. 그 조합에서도 문장이 나와야 하므로 어휘를 남긴다.
    case "agent_cli_unavailable": return "chrome.quickLaunch.errorCliUnavailable";
    // 첨부가 만료·소실된 실행 거절 — 초안과 칩은 돌아오지만, 그 칩의 서버 파일은 이미 없다.
    case "attachment_not_found": return "chrome.quickLaunch.errorAttachmentGone";
    case "attachment_limit": return "chrome.quickLaunch.errorAttachmentLimit";
    default: return "chrome.quickLaunch.errorGeneric";
  }
}
