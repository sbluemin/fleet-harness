// UserPromptSubmit 훅이 전달한 prompt에서 작전명 후보를 도출하는 순수 휴리스틱.
// 서버측에서만 호출되며(훅 차단 시간을 늘리지 않도록 LLM이 아닌 경량 규칙), 결과는 자동 작명에만 쓰인다.
// 자동 추출 라벨은 사용자의 의도적 공개가 아니므로, 먼저 제어문자·마크다운 wrapper·마커를 정규화한 뒤
// URL·절대경로·비밀토큰형·슬래시명령·저신호 줄을 "문장 어디에 있든" 걸러낸다(정규화 우회·중간 노출 차단).

const MAX_LABEL_LENGTH = 60;
const MIN_LABEL_LENGTH = 4;
const MAX_SCAN_LINES = 6;
const SECRET_MIN_TOKEN_LENGTH = 24;
const CODE_FENCE_PATTERN = /^(```|~~~)/;
const MARKER_PREFIX_PATTERN = /^([>#]+|[-*+]|\d+[.)])\s+/;
const WRAPPER_TRIM_PATTERN = /^[*_`~]+|[*_`~]+$/g;
// 제어문자(C0 + DEL)는 라벨 표시·필터 우회를 일으키므로 공백으로 치환한다. 리터럴 임베딩을 피해 escape 문자열로 구성한다.
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const WHITESPACE_RUN_PATTERN = /\s+/g;
const TRAILING_PUNCT_PATTERN = /[.,;:!?)\]}'"]+$/;
// 아래 패턴들은 "포함(substring)" 검사다 — 문장 중간의 민감값도 후보 전체를 폐기한다.
const URL_PATTERN = /(https?:\/\/|ftp:\/\/|www\.)/i;
const PATH_PATTERN = /(^|\s)(\/[^\s/]|~\/|\.{1,2}\/|[a-zA-Z]:[\\/])/;
const LOW_SIGNAL_PATTERN = /^(continue|계속|진행|다음|next|ok|okay|go|run|yes|yep|sure|y|n|no|네|응|예|그래|stop|wait|hold on|fix it|do it|please|thanks?|thank you)$/i;
const SECRET_PREFIX_PATTERN = /^(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-|sk_live_|sk_test_|pk-|rk-|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|glpat-|eyJ)/;
const SECRET_CHARSET_PATTERN = /^[A-Za-z0-9_\-+/=.]+$/;

export function deriveOperationLabel(prompt: unknown): string | null {
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  const lines = prompt.split(/\r?\n/);
  let examined = 0;
  let inFence = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    if (CODE_FENCE_PATTERN.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    examined += 1;
    if (examined > MAX_SCAN_LINES) break;
    const candidate = normalizeLine(trimmed);
    if (candidate !== null) return candidate;
  }
  return null;
}

function normalizeLine(line: string): string | null {
  // 1) 정규화를 먼저 수행한다: 제어문자 → 공백, 공백 정규화. (deny 검사가 숨은 접두문자로 우회되는 것을 막는다)
  let value = line.replace(CONTROL_CHAR_PATTERN, " ").replace(WHITESPACE_RUN_PATTERN, " ").trim();
  // 2) blockquote/heading/list 마커와 마크다운 emphasis wrapper를 번갈아 벗겨낸다("> - **item**", "**/clear**" 대비).
  for (let depth = 0; depth < 4; depth += 1) {
    const before = value;
    value = value.replace(MARKER_PREFIX_PATTERN, "").trim();
    value = value.replace(WRAPPER_TRIM_PATTERN, "").trim();
    if (value === before) break;
  }
  if (value.length === 0) return null;
  // 3) 정규화된 값에 대해 deny 검사를 적용한다(슬래시명령은 줄 시작, 나머지는 문장 어디든 포함이면 폐기).
  if (value.startsWith("/")) return null;
  if (URL_PATTERN.test(value)) return null;
  if (PATH_PATTERN.test(value)) return null;
  if (hasSecretToken(value)) return null;
  if (LOW_SIGNAL_PATTERN.test(value)) return null;
  if (value.length < MIN_LABEL_LENGTH) return null;
  return value.length > MAX_LABEL_LENGTH ? value.slice(0, MAX_LABEL_LENGTH).trimEnd() : value;
}

function hasSecretToken(value: string): boolean {
  return value.split(/\s+/).some(looksSecretToken);
}

function looksSecretToken(rawToken: string): boolean {
  const token = rawToken.replace(TRAILING_PUNCT_PATTERN, "");
  if (token.length === 0) return false;
  // 알려진 비밀 prefix(GitHub PAT, OpenAI/Slack/AWS/Google key, GitLab PAT, JWT 등)는 즉시 폐기.
  if (SECRET_PREFIX_PATTERN.test(token)) return true;
  // 일반 고엔트로피 토큰: 충분히 길고, 비밀 문자셋이며, 영문+숫자가 섞이면(해시/키 형태) 폐기.
  return token.length >= SECRET_MIN_TOKEN_LENGTH
    && SECRET_CHARSET_PATTERN.test(token)
    && /[0-9]/.test(token)
    && /[A-Za-z]/.test(token);
}
