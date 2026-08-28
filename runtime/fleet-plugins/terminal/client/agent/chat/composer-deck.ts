import type { AgentChatCatalog, AgentChatCatalogEntry } from "./chat-events.js";

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

/** 이름과 설명 모두에서 찾는다 — 스킬 이름은 자명하지 않아 설명이 유일한 실마리일 때가 많다. */
function matches(entry: AgentChatCatalogEntry, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle);
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
    const hits = entries.filter((entry) => matches(entry, token.query));
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
  /**
   * 이 선택이 곧 전송인가.
   *
   * 인자를 받지 않는 명령만 참이다. `argumentHint`가 있는 항목을 바로 보내면 인자 없이 나가고,
   * 에이전트는 지목만으로 할 일이 정해지지 않으므로 언제나 거짓이다 — 둘 다 사용자가 이어서
   * 쓸 자리를 남긴다.
   */
  readonly submit: boolean;
}

/**
 * 고른 항목을 초안에 앉힌다.
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
    const tail = value.slice(token.at + 1 + token.query.length);
    return { draft: `${value.slice(0, token.at)}@${entry.name} ${tail.replace(/^\s+/, "")}`, submit: false };
  }
  const submit = entry.argumentHint.length === 0;
  return { draft: submit ? `/${entry.name}` : `/${entry.name} `, submit };
}
