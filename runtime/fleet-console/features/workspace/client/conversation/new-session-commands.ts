/**
 * 새 세션 컴포저의 '/' 명령 판정 — 순수 함수만 둔다.
 *
 * 명령은 실행 좌표(어디서·무엇으로·얼마나·어떻게 열지)를 고르는 지름길이다. 칩 줄의 Theater 칩·모델 칩·강도 트랙·시작 보기 칩과
 * 같은 값을 바꾸고, 고르면 문면을 비운다 — 명령은 프롬프트가 아니다.
 */
export type NewSessionCommandId = "theater" | "model" | "effort" | "view";

export const NEW_SESSION_COMMANDS: readonly NewSessionCommandId[] = ["theater", "model", "effort", "view"];

export type NewSessionCommandInput =
  | { readonly kind: "commands"; readonly query: string }
  | { readonly kind: "values"; readonly command: NewSessionCommandId; readonly query: string };

/**
 * '/'는 프롬프트 **첫 글자**에서만 깨어난다 — '@'와 달리 `/`는 파일 경로의 첫 글자이기도 해서, 단어 시작마다 깨우면
 * `/Users/…`를 치는 내내 목록이 명멸한다. 첫 단어 안의 두 번째 `/`나 공백은 즉시 리터럴로 눕힌다. 첫 단어가 명령 토큰과
 * 정확히 일치하고 공백이 뒤따르면 값 단계다 — 값 질의는 모델 이름처럼 공백을 품을 수 있다.
 *
 * 질의는 caret이 아니라 문면에 앵커된다. 명령은 입력 전체를 소유하고 선택이 입력 전체를 갈아치우므로, caret 위치가
 * 목록과 실행을 가르면 보이는 필터와 Enter의 결과가 어긋난다 — caret은 "명령 영역 밖(0)"인지만 가른다.
 */
export function readCommandInput(value: string, caretIndex: number): NewSessionCommandInput | null {
  if (!value.startsWith("/")) return null;
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  if (caret < 1) return null;
  const boundary = value.slice(1).search(/\s/);
  const wordEnd = boundary === -1 ? value.length : boundary + 1;
  const word = value.slice(1, wordEnd);
  if (word.includes("/")) return null;
  if (boundary === -1) return { kind: "commands", query: word };
  const command = NEW_SESSION_COMMANDS.find((token) => token === word);
  if (!command) return null;
  return { kind: "values", command, query: value.slice(wordEnd + 1) };
}
