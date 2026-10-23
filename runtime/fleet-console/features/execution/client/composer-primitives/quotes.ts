/**
 * 컴포저 인용 — 다른 표면(Codex 문서 등)에서 고른 문장이 받는 쪽 입력창에 칩으로 붙는 첨부 종류.
 *
 * 이미지 첨부와 같은 자리·같은 손놀림이지만 바이트가 아니라 글이다. 붙이는 표면은 보내지 않는다 — 발사는 언제나 사람의 Enter 다.
 * 보낼 때 인용은 프롬프트 끝에 한 줄씩(`[Fleet quote] {json}`) 합성되고, 기록 재생은 같은 줄을 다시 읽어 칩으로 세운다.
 * 이 파일은 상태 없는 계약·검증·합성만 가진다. 인용 묶음 인스턴스(`createComposerQuotes`)는 각 입력창의 초안이 소유한다 —
 * 호스트·플러그인 번들이 이 모듈을 각자 적재하므로 모듈 스코프 상태는 두지 않는다.
 */

export type ComposerQuoteKind = "comment" | "question";

export interface ComposerQuoteSource {
  /** 사람이 읽는 출처 이름(예: Wiki 항목 제목). */
  readonly label: string;
  /** 받는 에이전트가 원문을 다시 찾을 좌표(예: `[[wiki:requirements]]`). */
  readonly ref?: string;
}

export interface ComposerQuote {
  readonly kind: ComposerQuoteKind;
  /** 고른 문장 그대로. */
  readonly excerpt: string;
  readonly source: ComposerQuoteSource;
  /** 이 인용에만 붙인 한 줄(선택). */
  readonly note?: string;
}

/** 붙일 곳 — 채팅 Objective 이거나, 인용을 받겠다고 나선 플러그인의 비-Objective 대상(사령관 등)이다. */
export type ComposerQuoteTarget =
  | { readonly kind: "objectiveRecord"; readonly objectiveId: string }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly targetId: string };

export type ComposerQuoteAttachResult = "attached" | "duplicate" | "limit" | "unavailable";

export const COMPOSER_MAX_QUOTES = 8;
export const COMPOSER_QUOTE_MAX_EXCERPT = 600;
export const COMPOSER_QUOTE_MAX_NOTE = 300;
export const COMPOSER_QUOTE_MAX_LABEL = 120;
export const COMPOSER_QUOTE_MAX_REF = 200;

/** 프롬프트 속 인용 줄의 머리. 재생은 이 머리와 검증을 함께 통과한 줄만 인용으로 읽는다. */
export const COMPOSER_QUOTE_LINE_PREFIX = "[Fleet quote] ";

// 줄 하나에 실려야 하므로 줄바꿈·제어 문자를 공백으로 접는다. U+FFFC 는 사령관 입력의 참조 표식이라 지운다.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const folded = value.replace(CONTROL, " ").replace(/￼/g, "").replace(/\s+/g, " ").trim();
  if (!folded) return null;
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

/** 바깥에서 온 값을 인용으로 — 형식이 틀리면 null. 긴 글은 상한에서 자른다. */
export function normalizeComposerQuote(value: unknown): ComposerQuote | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "comment" || record.kind === "question" ? record.kind : null;
  const excerpt = clean(record.excerpt, COMPOSER_QUOTE_MAX_EXCERPT);
  const sourceRecord = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : null;
  const label = sourceRecord ? clean(sourceRecord.label, COMPOSER_QUOTE_MAX_LABEL) : null;
  if (!kind || !excerpt || !label) return null;
  const ref = sourceRecord ? clean(sourceRecord.ref, COMPOSER_QUOTE_MAX_REF) : null;
  const note = clean(record.note, COMPOSER_QUOTE_MAX_NOTE);
  return { kind, excerpt, source: { label, ...(ref ? { ref } : {}) }, ...(note ? { note } : {}) };
}

/** 여러 값을 인용 목록으로 — 틀린 항목이 하나라도 있거나 상한을 넘으면 null(서버가 요청을 거절한다). */
export function normalizeComposerQuotes(value: unknown): readonly ComposerQuote[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > COMPOSER_MAX_QUOTES) return null;
  const quotes: ComposerQuote[] = [];
  for (const entry of value) {
    const quote = normalizeComposerQuote(entry);
    if (!quote) return null;
    quotes.push(quote);
  }
  return quotes;
}

function quoteLine(quote: ComposerQuote): string {
  return `${COMPOSER_QUOTE_LINE_PREFIX}${JSON.stringify({ kind: quote.kind, source: quote.source.label, ...(quote.source.ref ? { ref: quote.source.ref } : {}), excerpt: quote.excerpt, ...(quote.note ? { note: quote.note } : {}) })}`;
}

/** 사람이 쓴 문면 뒤에 인용 줄을 잇는다. 문면이 비면 인용 줄만으로 프롬프트가 된다. */
export function composeQuotedPrompt(text: string, quotes: readonly ComposerQuote[]): string {
  if (quotes.length === 0) return text;
  const lines = quotes.map(quoteLine).join("\n");
  return text.trim().length === 0 ? lines : `${text}\n\n${lines}`;
}

function readQuoteLine(line: string): ComposerQuote | null {
  if (!line.startsWith(COMPOSER_QUOTE_LINE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(COMPOSER_QUOTE_LINE_PREFIX.length)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeComposerQuote({ kind: parsed.kind, excerpt: parsed.excerpt, note: parsed.note, source: { label: parsed.source, ref: parsed.ref } });
  } catch {
    return null;
  }
}

/** 합성된 인용 줄을 **표시 문면에서** 걷어낸다 — 기록 재생과 사령관 기록이 말풍선 문면과 인용 칩을 되찾는 길이다. */
export function splitQuotedPrompt(text: string): { readonly text: string; readonly quotes: readonly ComposerQuote[] } {
  if (!text.includes(COMPOSER_QUOTE_LINE_PREFIX)) return { text, quotes: [] };
  const kept: string[] = [];
  const quotes: ComposerQuote[] = [];
  for (const line of text.split("\n")) {
    const quote = readQuoteLine(line);
    if (quote) quotes.push(quote);
    else kept.push(line);
  }
  if (quotes.length === 0) return { text, quotes: [] };
  return { text: kept.join("\n").trimEnd(), quotes };
}

export interface ComposerQuoteItem extends ComposerQuote {
  readonly key: string;
}

/** 한 입력창 초안의 인용 묶음. 인스턴스는 초안이 만들고 보관한다. */
export interface ComposerQuotes {
  read(): readonly ComposerQuoteItem[];
  subscribe(listener: () => void): () => void;
  /** 같은 출처의 같은 문장은 다시 붙지 않는다(`duplicate`). 상한을 넘으면 `limit`. */
  add(quote: ComposerQuote): ComposerQuoteAttachResult;
  update(key: string, patch: { readonly note?: string; readonly kind?: ComposerQuoteKind }): void;
  remove(key: string): void;
  /** 보낸 칩을 걷는다 — 보내는 사이 새로 붙은 칩은 남긴다. */
  releaseSent(keys: readonly string[]): void;
  clear(): void;
}

export function createComposerQuotes(): ComposerQuotes {
  let items: readonly ComposerQuoteItem[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();
  const publish = (next: readonly ComposerQuoteItem[]) => {
    items = next;
    for (const listener of listeners) listener();
  };
  return {
    read: () => items,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add: (input) => {
      const quote = normalizeComposerQuote(input);
      if (!quote) return "unavailable";
      if (items.some((item) => item.excerpt === quote.excerpt && item.source.label === quote.source.label && item.source.ref === quote.source.ref)) return "duplicate";
      if (items.length >= COMPOSER_MAX_QUOTES) return "limit";
      seq += 1;
      publish([...items, { ...quote, key: `quote-${seq}` }]);
      return "attached";
    },
    update: (key, patch) => {
      const at = items.findIndex((item) => item.key === key);
      if (at < 0) return;
      const current = items[at]!;
      const note = patch.note === undefined ? current.note : clean(patch.note, COMPOSER_QUOTE_MAX_NOTE) ?? undefined;
      const next: ComposerQuoteItem = { key: current.key, kind: patch.kind ?? current.kind, excerpt: current.excerpt, source: current.source, ...(note ? { note } : {}) };
      publish(items.map((item, index) => (index === at ? next : item)));
    },
    remove: (key) => { if (items.some((item) => item.key === key)) publish(items.filter((item) => item.key !== key)); },
    releaseSent: (keys) => { if (keys.length > 0) publish(items.filter((item) => !keys.includes(item.key))); },
    clear: () => { if (items.length > 0) publish([]); },
  };
}

/** 칩 목록에서 보낼 값만 — 칩 키는 화면의 것이라 싣지 않는다. */
export function composerQuoteValues(items: readonly ComposerQuoteItem[]): readonly ComposerQuote[] {
  return items.map(({ key: _key, ...quote }) => quote);
}
