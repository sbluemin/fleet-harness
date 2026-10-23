import type { ReactNode } from "react";
import type { MentionTargetDescriptor } from "../../../execution/shared/composer-ports.js";
import type { ObjectiveClusterRow } from "../../../objectives/shared/objective-clusters.js";

import type { ObjectiveActivityVisual } from "../../../execution/client/objective-activity.js";
import { buildObjectiveSearchEntries, filterObjectiveSearchEntries, groupObjectiveSearchEntries, searchTokens, type ObjectiveSearchEntry, type ObjectiveSearchGroup } from "../../../../core/client/src/integration/objective-search.js";
import type { ConsoleState } from "../../../../core/client/src/integration/types.js";

/**
 * 새 세션 컴포저의 '@' 행선지 — 토큰 읽기, Objective·플러그인 행선지 목록, 전달 거절 문구. 순수 함수만 둔다.
 */

export interface MentionToken {
  readonly at: number;
  readonly query: string;
}

/**
 * caret 앞의 `@`가 문두나 공백 뒤에 있고 caret까지 공백·`@`가 섞이지 않았을 때만 멘션 토큰이다 —
 * 문장 중간의 이메일·리터럴 `@`는 목록을 깨우지 않는다.
 */
export function readMentionToken(value: string, caretIndex: number): MentionToken | null {
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
export function stripMentionToken(value: string, token: MentionToken): string {
  return `${value.slice(0, token.at)}${value.slice(token.at + 1 + token.query.length)}`;
}

/**
 * awaiting은 CLI가 응답 입력을 기다리는 상태라 임의 텍스트가 프롬프트 응답을 오염시킨다 —
 * 목록에서 dim + 선택 불가 + 방향키 스킵(제품 결정). dormant는 선택 가능하며 서버가 재기동 후 전달한다.
 */
export function isMentionSelectable(activity: ObjectiveActivityVisual): boolean {
  return activity !== "awaiting";
}

/**
 * 멘션 덱의 목록: messageObjective을 선언한 플러그인의 해당 타입 Objective만, Theater로 묶어서.
 * 원천은 활성 목록(`state.objectiveRecords`)뿐이다 — 보관함 스냅샷(팔레트의 `refreshObjectiveArchive`)은 섞지 않으므로 보관된
 * Objective 은 '@'에 서지 않는다.
 * 구성원(부모가 대표하는 Objective)은 스토어의 기본 목록에 없으므로 덱에도 서지 않는다.
 * 활동 분류는 팔레트와 같은 원천(resolveObjectiveActivity)을 쓰되 idle-arrival 화면 승격은 받지
 * 않는다 — 여기서 awaiting은 선택 차단 신호라, 표시용 승격이 섞이면 보낼 수 있는 대상이 막힌다.
 */
export function buildMentionGroups(
  state: ConsoleState,
  messageableTypesByPlugin: ReadonlyMap<string | null, ReadonlySet<string>>,
  query: string,
): readonly ObjectiveSearchGroup[] {
  const mentionable = state.objectiveRecords.filter((objectiveRecord) => messageableTypesByPlugin.get("terminal")?.has("agent") === true);
  if (mentionable.length === 0) return [];
  const entries = buildObjectiveSearchEntries({ ...state, objectiveRecords: mentionable });
  return groupObjectiveSearchEntries(filterObjectiveSearchEntries(entries, query));
}

/**
 * 「시작 전」 — 사이드바 「시작 전 N」 접기·모바일 홈 「시작 전」과 같은 원천이다. Objective 을 대표하는 묶음 줄(`ClusterIndex.rowOf`)의
 * 글리프가 `fresh`(SDK `ObjectiveClusterRowGlyph`, 플러그인이 세션 없는 시작 전 줄에 단다)이고 사람이 답할 결정이 걸려 있지 않은
 * 줄이다(결정이 걸리면 「내 결정」으로 올라간다). 정의를 사이드바 하나에 두어야 두 화면이 어긋나지 않는다.
 */
export function isNotStartedRow(row: ObjectiveClusterRow | undefined): boolean {
  return row?.glyph === "fresh" && row.decisionRequestedAt === undefined;
}

/**
 * '@' Objective 묶음을 ObjectiveRecords 와 「시작 전」으로 가른다. Theater 띠 순서는 그대로 두고, 행이 남지 않은 띠는 뺀다.
 * 데스크톱 새 세션 화면과 모바일 새 대화 시트가 같은 결과를 받는다(`useMentionSources`).
 */
export function splitNotStartedGroups(
  groups: readonly ObjectiveSearchGroup[],
  rowOf: (objectiveId: string) => ObjectiveClusterRow | undefined,
): { readonly objectiveRecordGroups: readonly ObjectiveSearchGroup[]; readonly pendingGroups: readonly ObjectiveSearchGroup[] } {
  const objectiveRecordGroups: ObjectiveSearchGroup[] = [];
  const pendingGroups: ObjectiveSearchGroup[] = [];
  for (const group of groups) {
    const pending = group.entries.filter((entry) => isNotStartedRow(rowOf(entry.objectiveId)));
    if (pending.length === 0) { objectiveRecordGroups.push(group); continue; }
    const rest = group.entries.filter((entry) => !pending.includes(entry));
    if (rest.length > 0) objectiveRecordGroups.push({ ...group, entries: rest });
    pendingGroups.push({ ...group, entries: pending });
  }
  return { objectiveRecordGroups, pendingGroups };
}

/**
 * 플러그인이 기여한 비-Objective 행선지 한 줄. 호스트가 쓰는 모양으로 눕힌 것이라 descriptor를
 * 그대로 들고 다니지 않는다 — `optionId`가 이름공간을 나눈 유일한 신원이고, DOM id도 이 값이다.
 */
export interface PluginMentionRow {
  readonly pluginId: string | null;
  readonly targetId: string;
  readonly optionId: string;
  readonly label: string;
  readonly categoryLabel: string;
  readonly capabilityLabel: string | null;
  readonly description: string | null;
  readonly renderMark: (() => ReactNode) | null;
}

/** 덱에서 한 카테고리 밴드 아래 서는 행 묶음. */
export interface MentionCategory {
  readonly key: string;
  readonly label: string;
  readonly capabilityLabel: string | null;
  readonly rows: readonly PluginMentionRow[];
}

/** 덱이 읽는 플러그인의 최소 모양. 컴포넌트가 레지스트리 전체를 넘기지 않아도 단위 테스트가 돈다. */
export interface MentionSource {
  readonly id: string | null;
  readonly mentionTargets?: () => readonly MentionTargetDescriptor[];
  readonly messageMentionTarget?: (targetId: string, text: string) => Promise<void>;
}

/** 확정된 행선지. Objective과 플러그인 대상은 전달 경로도 태그도 달라서 판별 유니온으로 둔다. */
export type MentionTarget =
  | { readonly kind: "objectiveRecord"; readonly entry: ObjectiveSearchEntry }
  | { readonly kind: "plugin"; readonly row: PluginMentionRow };

/** 행선지의 이름 — 안내문·칩·거절 문구가 공유하는 한 값. */
export function mentionTargetName(target: MentionTarget): string {
  return target.kind === "objectiveRecord" ? target.entry.objectiveRecordName : target.row.label;
}

/**
 * 플러그인 기여 행선지의 카테고리 목록.
 *
 * `mentionTargets`와 `messageMentionTarget`을 **함께** 선언한 플러그인만 읽는다 — 목록에만 서고
 * 받지 못하는 행선지는 고르는 순간 막다른 길이 된다(Objective 쪽 `messageObjective` 짝 조건과 같다).
 * 로스터를 읽다 던지는 플러그인은 그 플러그인만 빠지고 덱은 계속 선다.
 */
export function buildPluginMentionCategories(
  plugins: readonly MentionSource[],
  query: string,
): readonly MentionCategory[] {
  const tokens = searchTokens(query);
  const categories: MentionCategory[] = [];
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
      // description 은 번역 문장이라 넣지 않는다 — 조사·일반어가 엉뚱한 행을 맞춘다. 숨은 이름은 keywords 로 온다.
      const haystack = [descriptor.label, descriptor.categoryLabel, plugin.id ?? "", ...(descriptor.keywords ?? [])].join(" ").toLocaleLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      const row: PluginMentionRow = {
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
 * Objective 하나를 멘션 행선지로 해소한다. 덱과 같은 원천을 빈 질의로 읽어 "메시지를 받는 타입인가"를
 * 확인하고, 입력 대기 중인 대상은 덱과 같은 이유로 거른다(임의 텍스트가 CLI 프롬프트 응답을 오염시킨다).
 *
 * 명시 행선지(플러그인이 `composer.open({ mentionObjectiveId })`로 건네는 시드)의 판정이다. 시드는 그 패널을 직접 가리킨
 * 지시라 어느 Theater의 패널인지가 의도를 바꾸지 않는다.
 */
export function resolveMentionEntry(
  state: ConsoleState,
  messageableTypesByPlugin: ReadonlyMap<string | null, ReadonlySet<string>>,
  objectiveId: string,
): ObjectiveSearchEntry | null {
  // 명시 행선지는 한 Objective 을 가리키는 길이다 — 덱에 서지 않는 구성원(부모 패널이 본문으로 보이는)도 주소가 된다.
  const entry = buildMentionGroups({ ...state, objectiveRecords: [...state.objectiveRecords, ...state.nestedObjectiveRecords] }, messageableTypesByPlugin, "")
    .flatMap((group) => group.entries)
    .find((candidate) => candidate.objectiveId === objectiveId);
  if (!entry || !isMentionSelectable(entry.activity)) return null;
  return entry;
}

/**
 * 멘션 전달 거절 코드를 문구 키로 옮긴다. 런치 거절 코드와 겹치는 것은 그 문구를 재사용하고,
 * 모르는 코드는 일반 실패 문구로 떨어뜨린다.
 */
export function mentionErrorMessageKey(code: string | null): string {
  switch (code) {
    case "resume_unavailable": return "chrome.launch.mentionErrorResumeUnavailable";
    case "session_awaiting_input": return "chrome.launch.mentionErrorAwaiting";
    case "claude_trust_required": return "chrome.launch.mentionErrorTrustRequired";
    // 비-Objective 행선지가 아직 앞 질문에 답하는 중 — 조용히 삼키면 사용자의 문장이 사라진다.
    case "destination_busy": return "chrome.launch.mentionErrorBusy";
    case "session_capacity": return "chrome.launch.mentionErrorCapacity";
    case "session_not_found": return "chrome.launch.mentionErrorGone";
    case "prompt_too_long": return "chrome.launch.errorTooLong";
    case "attachment_limit": return "chrome.launch.errorAttachmentLimit";
    case "gateway_model_not_enabled": return "chrome.launch.errorModelOff";
    case "invalid_effort": return "chrome.launch.errorEffortOff";
    case "agent_cli_not_installed": return "chrome.launch.errorCliNotInstalled";
    case "agent_cli_signed_out": return "chrome.launch.errorCliSignedOut";
    // preflight를 통과한 뒤 spawn 단계에서 죽은 경우 — 설정된 실행 파일 자체의 문제다.
    case "agent_cli_binary_missing": return "chrome.launch.errorCliBinaryMissing";
    case "agent_cli_not_executable": return "chrome.launch.errorCliNotExecutable";
    // 옛 서버는 두 원인을 이 하나로 보냈다. 그 조합에서도 문장이 나와야 하므로 어휘를 남긴다.
    case "agent_cli_unavailable": return "chrome.launch.errorCliUnavailable";
    default: return "chrome.launch.mentionErrorDeliveryFailed";
  }
}

