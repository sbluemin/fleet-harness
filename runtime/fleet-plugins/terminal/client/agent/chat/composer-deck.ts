import type { AgentChatCatalog, AgentChatCatalogEntry, ChatCommandConsoleTarget } from "./chat-events.js";

/**
 * 채팅 컴포저의 두 덱이 쓰는 순수 판정.
 *
 * 컴포넌트에서 떼어 두는 이유는 Quick Launch가 `quick-launch.ts`를 떼어 둔 이유와 같다 —
 * 렌더러를 세우지 않고 웨이크 규칙과 선택 결과를 단위 테스트로 못박기 위해서다.
 *
 * 두 글자는 서로 다른 것을 부른다. `/`는 **세션의 능력**(내장 명령·스킬)이고 `@`는
 * **행위자**(서브에이전트)다. 한 글자에 둘을 섞지 않는 이유는 문법이 실제로 다르기 때문이다:
 * 슬래시 항목은 자식이 `/이름`으로 받아 주지만 서브에이전트는 Task 도구로만 불린다. 에이전트를
 * 슬래시 목록에 세우면 없는 문법을 가르치게 되고, 사용자는 `/Explore`를 보내고 침묵을 받는다.
 */

/** 덱을 깨운 글자. */
export type ChatDeckKind = "slash" | "agent";

export interface ChatDeckToken {
  readonly kind: ChatDeckKind;
  /** 글자가 앉은 인덱스. 확정 시 이 자리부터 갈아 끼운다. */
  readonly at: number;
  /** 글자 뒤부터 caret까지의 질의. */
  readonly query: string;
}

/**
 * `/`는 프롬프트 **첫 글자**에서만 깨어난다.
 *
 * 단어 시작마다 깨우면 `/Users/…` 같은 경로를 치는 내내 덱이 명멸한다(Quick Launch가 같은
 * 이유로 같은 규칙을 쓴다). 첫 단어 안의 두 번째 `/`나 공백은 즉시 리터럴로 눕힌다.
 */
export function readSlashToken(value: string, caretIndex: number): ChatDeckToken | null {
  if (!value.startsWith("/")) return null;
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  if (caret < 1) return null;
  const boundary = value.slice(1).search(/\s/);
  if (boundary !== -1) return null;
  const word = value.slice(1);
  if (word.includes("/")) return null;
  return { kind: "slash", at: 0, query: word };
}

/**
 * `@`는 문두나 공백 뒤에서 깨어나고, caret까지 공백·`@`가 섞이면 눕는다.
 *
 * 문장 중간의 이메일과 리터럴 `@`가 덱을 깨우지 않는 유일한 근거가 이 규칙이다 — Quick Launch의
 * 멘션 토큰과 같은 계약을 쓴다(같은 글자에 두 규칙을 두면 표면마다 다르게 눕는다).
 */
export function readAgentToken(value: string, caretIndex: number): ChatDeckToken | null {
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  const at = value.lastIndexOf("@", caret - 1);
  if (at < 0 || at >= caret) return null;
  if (at > 0 && !/\s/.test(value[at - 1] ?? "")) return null;
  const query = value.slice(at + 1, caret);
  if (/[\s@]/.test(query)) return null;
  return { kind: "agent", at, query };
}

/**
 * 지금 열려야 할 덱. `/`가 `@`를 이긴다 — 첫 글자가 `/`인 입력에서 뒤에 `@`가 나오면 그것은
 * 명령의 인자이지 멘션이 아니다.
 */
export function readDeckToken(value: string, caretIndex: number): ChatDeckToken | null {
  return readSlashToken(value, caretIndex) ?? readAgentToken(value, caretIndex);
}

export interface ChatDeckSection {
  /** 문구 키가 아니라 분류 id다 — 라벨은 렌더러가 i18n에서 고른다. */
  readonly id: "commands" | "skills" | "agents";
  readonly entries: readonly AgentChatCatalogEntry[];
}

/**
 * 이 항목이 질의에 얼마나 가까운가. 작을수록 위에 선다. 맞지 않으면 `null`.
 *
 * 이름과 설명을 **함께** 보는 것은 그대로 둔다 — 스킬 이름은 자명하지 않아 설명이 유일한
 * 실마리일 때가 많다. 다만 둘을 같은 무게로 두면 이름을 정확히 친 사람이 다른 행을 받는다:
 * `/context`를 끝까지 쳐도 설명에 "context"가 든 `/clear`·`/compact`가 함께 서고, 목록 순서상
 * `/clear`가 첫 행이 되어 그 Enter가 **문맥을 지우는 명령**을 완성한다(실측에서 그렇게 됐다).
 * 정확한 이름은 언제나 첫 행이어야 한다.
 */
function rank(entry: AgentChatCatalogEntry, query: string): number | null {
  if (query.length === 0) return 0;
  const needle = query.toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return entry.description.toLowerCase().includes(needle) ? 3 : null;
}

/**
 * 덱이 세울 구획. 비어 있는 구획은 아예 만들지 않는다 — 항목 0개짜리 머리글이 서면
 * 고정 헤더가 빈 칸만 붙들고 스크롤을 따라다닌다.
 */
export function buildDeckSections(
  catalog: AgentChatCatalog | null,
  token: ChatDeckToken,
): readonly ChatDeckSection[] {
  if (!catalog) return [];
  const pick = (id: ChatDeckSection["id"], entries: readonly AgentChatCatalogEntry[]): readonly ChatDeckSection[] => {
    const hits = entries
      .flatMap((entry) => {
        const score = rank(entry, token.query);
        return score === null ? [] : [{ entry, score }];
      })
      // 같은 근접도 안에서는 카탈로그 순서를 지킨다 — 이름순으로 다시 세우면 자식이 준
      // 순서(내장 명령의 관용적 배열)가 사라지고 목록이 매 판본 흔들린다.
      .sort((a, b) => a.score - b.score)
      .map((hit) => hit.entry);
    return hits.length > 0 ? [{ id, entries: hits }] : [];
  };
  if (token.kind === "agent") return pick("agents", catalog.agents);
  return [...pick("commands", catalog.commands), ...pick("skills", catalog.skills)];
}

/** 구획을 평평한 행 목록으로 편다. 방향키는 머리글을 건너뛰므로 이 목록이 곧 이동 축이다. */
export function flattenDeckRows(sections: readonly ChatDeckSection[]): readonly AgentChatCatalogEntry[] {
  return sections.flatMap((section) => section.entries);
}

export interface ChatDeckPick {
  /** 확정 뒤의 초안. */
  readonly draft: string;
  /** 확정 뒤 캐럿이 앉을 자리. 이어서 인자를 치는 자리이므로 언제나 삽입된 토큰의 끝이다. */
  readonly caret: number;
}

/**
 * 고른 항목을 초안에 앉힌다. **보내지 않는다 — 입력을 완성할 뿐이다.**
 *
 * 인자 없는 명령을 즉시 보내던 초기 계약을 접었다: 같은 Enter가 어떤 행에서는 완성이고 어떤
 * 행에서는 전송이면, 사용자는 목록을 고르기 전에 그 행이 어느 쪽인지 먼저 알아야 한다. 완성은
 * 언제나 완성이고, 보내는 것은 그다음 Enter다 — 자동완성이 지키는 통상 약속과 같다.
 *
 * 슬래시는 입력 전체를 소유하므로 통째로 갈아 끼우고, 멘션은 문장 중간에 있을 수 있어 토큰
 * 구간만 바꾼다 — 뒤에 이미 쓴 문장이 있으면 그대로 살아남는다.
 */
export function applyDeckPick(
  value: string,
  token: ChatDeckToken,
  entry: AgentChatCatalogEntry,
): ChatDeckPick {
  if (token.kind === "agent") {
    const head = `${value.slice(0, token.at)}@${entry.name} `;
    const tail = value.slice(token.at + 1 + token.query.length).replace(/^\s+/, "");
    return { draft: `${head}${tail}`, caret: head.length };
  }
  const head = `/${entry.name} `;
  return { draft: head, caret: head.length };
}

/** Console이 자식 대신 받는 지시 하나. */
export interface ChatConsoleCommand {
  readonly target: ChatCommandConsoleTarget;
  /** 명령 이름 뒤에 남은 문면. 없으면 빈 문자열이다. */
  readonly argument: string;
  /** 사용자가 실제로 친 이름 — 되돌려 줄 안내 문구가 이 이름을 부른다. */
  readonly name: string;
}

/**
 * 이 초안이 **Console이 받아야 하는** 명령인가. 보내기 직전에 묻는다.
 *
 * 덱에서 고른 순간이 아니라 보내는 순간에 판정하는 이유가 두 가지다. 첫째, 인자를 받는 명령
 * (`/rename 새 이름`)은 고른 뒤에도 계속 쓰이므로 확정 시점에는 아직 지시가 완성되지 않았다.
 * 둘째, 덱을 거치지 않고 손으로 친 `/rename`도 같은 판정을 받아야 한다 — 두 입구가 다른 곳으로
 * 가면 사용자는 어느 쪽으로 쳤는지에 따라 다른 제품을 쓰게 된다.
 *
 * 그래서 Enter의 뜻은 하나로 남는다: **보낸다.** 그 "보냄"이 자식에게 가는지 Console이 받는지는
 * 정책이 정하고, 덱의 행이 그것을 미리 말한다.
 */
export function readConsoleCommand(
  value: string,
  catalog: AgentChatCatalog | null,
): ChatConsoleCommand | null {
  if (!catalog) return null;
  const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
  if (!match) return null;
  const name = match[1]!;
  const entry = catalog.commands.find((candidate) => candidate.name === name);
  if (!entry?.console) return null;
  return { target: entry.console, argument: (match[2] ?? "").trim(), name };
}

/**
 * 문면에서 **카탈로그에 실제로 있는** 토큰 구간들을 찾는다. 완성된 좌표에 색을 입히는 자리다.
 *
 * 카탈로그와 대조하는 이유는 정직함이다: 모양만 맞으면 칠해 버리면 오타난 `/desing`도 유효한
 * 좌표처럼 보인다. 이름이 목록에 있을 때만 칠하므로, 색이 곧 "이건 실제로 부를 수 있다"는 뜻이 된다.
 */
export function readResolvedTokenRanges(
  value: string,
  catalog: AgentChatCatalog | null,
): readonly { readonly start: number; readonly end: number }[] {
  if (!catalog) return [];
  const ranges: { start: number; end: number }[] = [];
  const slashNames = new Set([...catalog.commands, ...catalog.skills].map((entry) => entry.name));
  const slash = /^\/([A-Za-z0-9:_-]+)(?=\s|$)/.exec(value);
  if (slash && slashNames.has(slash[1]!)) ranges.push({ start: 0, end: slash[0].length });
  const agentNames = new Set(catalog.agents.map((entry) => entry.name));
  const mention = /(?<=^|\s)@([A-Za-z0-9:._-]+)(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = mention.exec(value)) !== null) {
    if (agentNames.has(match[1]!)) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges.sort((a, b) => a.start - b.start);
}
