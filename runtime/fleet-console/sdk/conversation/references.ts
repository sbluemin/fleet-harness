/**
 * 문면 속 참조 — 사람이 말의 그 자리에 둔 대상(사령관 입력의 '@' 지휘관 등)이다.
 *
 * 문면은 참조마다 `CONVERSATION_REFERENCE_MARK` 한 글자를 그 자리에 싣고, 참조 목록은 그 글자가 나온 순서다. 글자 수와 목록 길이는
 * 같아야 한다 — 저자(플러그인 서버)가 그 일치를 검증한 뒤에만 싣는다. 그리는 쪽은 짝이 맞지 않는 글자를 토큰으로 세우지 않고 버린다.
 * 표식 글자는 유니코드 「객체 대체 문자」(U+FFFC)다 — 본래 뜻이 「글자 자리에 선 다른 객체」이고, 사람이 칠 일이 없는 글자다.
 */
export interface ConversationReference {
  readonly id: string;
  /** 토큰에 보이는 이름(목표 제목 등). */
  readonly label: string;
}

export const CONVERSATION_REFERENCE_MARK = "￼";

export type ConversationReferencePart = string | ConversationReference;

/** 문면을 글 조각과 참조로 가른다. 목록보다 많은 표식은 지우고, 표식보다 많은 참조는 버린다. 빈 글 조각은 싣지 않는다. */
export function splitReferenceText(text: string, references: readonly ConversationReference[] | undefined): readonly ConversationReferencePart[] {
  if (!references?.length || !text.includes(CONVERSATION_REFERENCE_MARK)) return text ? [text.split(CONVERSATION_REFERENCE_MARK).join("")] : [];
  const parts: ConversationReferencePart[] = [];
  const pieces = text.split(CONVERSATION_REFERENCE_MARK);
  pieces.forEach((piece, index) => {
    if (piece) {
      const last = parts.at(-1);
      if (typeof last === "string") parts[parts.length - 1] = last + piece;
      else parts.push(piece);
    }
    const reference = index < pieces.length - 1 ? references[index] : undefined;
    if (reference) parts.push(reference);
  });
  return parts;
}

/** 토큰을 그릴 수 없는 자리(접힌 한 줄 요약·알림)를 위한 평문 — 참조 자리는 `@이름` 이다. */
export function referencePlainText(text: string, references: readonly ConversationReference[] | undefined): string {
  return splitReferenceText(text, references).map((part) => (typeof part === "string" ? part : `@${part.label}`)).join("");
}
