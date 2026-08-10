#!/usr/bin/env node
// Fleet workflow model guard — Admiral 정책 게이트 (PreToolUse, matcher: Workflow).
//
// dynamic workflow 스크립트를 디스패치하기 전에 검증해 세 가지 사고를 차단한다:
//   1. opts.agentType 사용 (금지 — agentType은 팀메이트/서브에이전트 표면 전용)
//   2. opts.model 값이 lineage alias도, claude-gateway-- 접두 modelId도 아닌 경우
//      (gateway_models의 modelId에서 claude-gateway-- prefix를 누락한 사고)
//   3. agent() 호출에 리터럴 opts.model pin이 없어 세션 모델을 상속하는 경우
//
// stdin으로 PreToolUse 훅 입력 JSON({ tool_name, tool_input, ... })을 받고,
// 위반 시 stderr에 사유를 쓰고 exit 2로 호출을 차단한다. 통과 시 exit 0.
// 백그라운드 활동 카운팅 신호가 아니므로 호스트로 어떤 신호도 보내지 않는다.
import { readFileSync } from "node:fs";

const MODEL_ALIASES = /^(fable|opus|sonnet|haiku)$/;
const PREFIXED_ALIAS_RE = /^claude-gateway--(fable|opus|sonnet|haiku)$/;
const GATEWAY_MODEL_PREFIX = "claude-gateway--";
const AGENT_TYPE_RE = /agentType\s*:/;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;
const OPEN_TO_CLOSE = { "(": ")", "[": "]", "{": "}" };
const CLOSING_DELIMITERS = new Set(Object.values(OPEN_TO_CLOSE));

function block(message) {
  process.stderr.write(`[workflow-guard] ${message}\n`);
  process.exit(2);
}

function skipQuotedString(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function skipLineComment(source, start) {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source, start) {
  const close = source.indexOf("*/", start + 2);
  return close === -1 ? source.length : close + 2;
}

function skipComment(source, start) {
  if (source[start] !== "/") return start;
  if (source[start + 1] === "/") return skipLineComment(source, start);
  if (source[start + 1] === "*") return skipBlockComment(source, start);
  return start;
}

/**
 * `/`가 나눗셈이 아니라 정규식의 시작인지. 직전 유효 문자가 값을 끝내는 자리(식별자·숫자·닫는
 * 괄호)면 나눗셈이고, 그렇지 않으면 정규식이다. 판정이 서지 않으면 나눗셈으로 본다 — 정규식으로
 * 오인해 뒤를 통째로 삼키는 쪽이 훨씬 나쁘다.
 */
function isRegexPosition(source, start) {
  let index = start - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  if (index < 0) return true;
  const previous = source[index];
  if (/[)\]}]/.test(previous)) return false;
  if (/[A-Za-z0-9_$]/.test(previous)) {
    let wordEnd = index + 1;
    let wordStart = index;
    while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
    const word = source.slice(wordStart + 1, wordEnd);
    return ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"].includes(word);
  }
  return true;
}

/**
 * 정규식 리터럴을 건너뛴다. 문자 클래스(`[...]`) 안의 `/`는 종결자가 아니므로 클래스 안팎을
 * 따로 센다 — 이 구분이 없으면 `/[)]/g` 같은 리터럴의 `)`가 실제 닫는 괄호로 읽혀,
 * 정상 스크립트의 `agent()` 인수 경계를 찾지 못하고 pin이 없다고 오판한다.
 */
function skipRegexLiteral(source, start) {
  if (source[start] !== "/" || !isRegexPosition(source, start)) return start;
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") return start;
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return start;
}

function findMatchingDelimiter(source, openIndex) {
  const first = source[openIndex];
  if (!OPEN_TO_CLOSE[first]) return -1;

  const stack = [first];
  let index = openIndex + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"') {
      index = skipQuotedString(source, index);
      continue;
    }
    if (character === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = afterComment;
      continue;
    }
    const afterRegex = skipRegexLiteral(source, index);
    if (afterRegex !== index) {
      index = afterRegex;
      continue;
    }
    if (OPEN_TO_CLOSE[character]) {
      stack.push(character);
      index += 1;
      continue;
    }
    if (CLOSING_DELIMITERS.has(character)) {
      const open = stack.pop();
      if (OPEN_TO_CLOSE[open] !== character) return -1;
      if (stack.length === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function skipTemplateLiteral(source, start, interpolationRanges) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") return index + 1;
    if (source[index] === "$" && source[index + 1] === "{") {
      const close = findMatchingDelimiter(source, index + 1);
      if (close === -1) return source.length;
      interpolationRanges?.push([index + 2, close]);
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return source.length;
}

function skipTrivia(source, start, end = source.length) {
  let index = start;
  while (index < end) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = Math.min(afterComment, end);
      continue;
    }
    const afterRegex = skipRegexLiteral(source, index);
    if (afterRegex !== index) {
      index = Math.min(afterRegex, end);
      continue;
    }
    break;
  }
  return index;
}

function findAgentCallsInRange(source, start, end, calls) {
  let index = start;
  let previousSignificant = "";
  while (index < end) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = Math.min(afterComment, end);
      continue;
    }
    const afterRegex = skipRegexLiteral(source, index);
    if (afterRegex !== index) {
      index = Math.min(afterRegex, end);
      continue;
    }
    if (character === "'" || character === '"') {
      index = Math.min(skipQuotedString(source, index), end);
      previousSignificant = character;
      continue;
    }
    if (character === "`") {
      const interpolationRanges = [];
      const afterTemplate = skipTemplateLiteral(source, index, interpolationRanges);
      for (const [interpolationStart, interpolationEnd] of interpolationRanges) {
        findAgentCallsInRange(source, interpolationStart, interpolationEnd, calls);
      }
      index = Math.min(afterTemplate, end);
      previousSignificant = "`";
      continue;
    }
    if (IDENTIFIER_CHAR_RE.test(character)) {
      let identifierEnd = index + 1;
      while (identifierEnd < end && IDENTIFIER_CHAR_RE.test(source[identifierEnd])) identifierEnd += 1;
      const identifier = source.slice(index, identifierEnd);
      if (identifier === "agent" && previousSignificant !== "." && previousSignificant !== "#") {
        const openIndex = skipTrivia(source, identifierEnd, end);
        if (source[openIndex] === "(") {
          const closeIndex = findMatchingDelimiter(source, openIndex);
          const afterCall = closeIndex === -1 ? -1 : skipTrivia(source, closeIndex + 1, end);
          if (afterCall === -1 || source[afterCall] !== "{") {
            calls.push({ start: index, open: openIndex, close: closeIndex });
          }
        }
      }
      previousSignificant = source[identifierEnd - 1];
      index = identifierEnd;
      continue;
    }
    previousSignificant = character;
    index += 1;
  }
}

function findAgentCalls(source) {
  const calls = [];
  findAgentCallsInRange(source, 0, source.length, calls);
  return calls.sort((left, right) => left.start - right.start);
}

function splitTopLevelRanges(source, start, end) {
  if (start === end) return [];

  const ranges = [];
  const stack = [];
  let rangeStart = start;
  let index = start;
  while (index < end) {
    const character = source[index];
    if (character === "'" || character === '"') {
      index = skipQuotedString(source, index);
      continue;
    }
    if (character === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = afterComment;
      continue;
    }
    const afterRegex = skipRegexLiteral(source, index);
    if (afterRegex !== index) {
      index = afterRegex;
      continue;
    }
    if (OPEN_TO_CLOSE[character]) {
      stack.push(character);
      index += 1;
      continue;
    }
    if (CLOSING_DELIMITERS.has(character)) {
      const open = stack.pop();
      if (OPEN_TO_CLOSE[open] !== character) return [];
      index += 1;
      continue;
    }
    if (character === "," && stack.length === 0) {
      ranges.push([rangeStart, index]);
      rangeStart = index + 1;
    }
    index += 1;
  }
  if (stack.length > 0) return [];
  ranges.push([rangeStart, end]);
  return ranges;
}

function readQuotedLiteral(source, start, end) {
  const after = skipQuotedString(source, start);
  if (after > end || source[after - 1] !== source[start]) return undefined;
  return { after, value: source.slice(start + 1, after - 1) };
}

function readModelProperty(source, start, end) {
  let index = skipTrivia(source, start, end);
  let key;
  if (source[index] === "'" || source[index] === '"') {
    const literal = readQuotedLiteral(source, index, end);
    if (!literal) return undefined;
    key = literal.value;
    index = literal.after;
  } else if (source.startsWith("model", index) && !IDENTIFIER_CHAR_RE.test(source[index + 5] ?? "")) {
    key = "model";
    index += 5;
  } else {
    return undefined;
  }
  if (key !== "model") return undefined;

  index = skipTrivia(source, index, end);
  if (source[index] !== ":") return { literal: false };
  index = skipTrivia(source, index + 1, end);
  if (source[index] !== "'" && source[index] !== '"') return { literal: false };

  const literal = readQuotedLiteral(source, index, end);
  if (!literal || skipTrivia(source, literal.after, end) !== end) return { literal: false };
  return { literal: true, value: literal.value };
}

function findLiteralModelPin(source, call) {
  if (call.close === -1) return undefined;
  const argumentRanges = splitTopLevelRanges(source, call.open + 1, call.close);
  if (argumentRanges.length < 2) return undefined;

  const [optionsStart, optionsEnd] = argumentRanges[1];
  const objectStart = skipTrivia(source, optionsStart, optionsEnd);
  if (source[objectStart] !== "{") return undefined;
  const objectClose = findMatchingDelimiter(source, objectStart);
  if (objectClose === -1 || skipTrivia(source, objectClose + 1, optionsEnd) !== optionsEnd) return undefined;

  let pin;
  for (const [propertyStart, propertyEnd] of splitTopLevelRanges(source, objectStart + 1, objectClose)) {
    const property = readModelProperty(source, propertyStart, propertyEnd);
    if (property) pin = property;
  }
  return pin?.literal ? pin.value : undefined;
}

/**
 * 코드 위치의 `model:` 리터럴만 모은다. 스크립트 전체를 정규식으로 훑으면 프롬프트 문장이나
 * 주석에 적힌 `model: "gpt-4"` 같은 산문까지 값으로 읽혀, 아무 잘못 없는 워크플로우가 차단된다.
 * 키로 쓰인 "model"과 그저 그렇게 시작하는 문자열을 가르려면 따옴표 안을 끝까지 읽어야 한다.
 */
function findModelPinValues(source, start, end, values) {
  let index = start;
  while (index < end) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = Math.min(afterComment, end);
      continue;
    }
    const afterRegex = skipRegexLiteral(source, index);
    if (afterRegex !== index) {
      index = Math.min(afterRegex, end);
      continue;
    }
    if (character === "'" || character === '"') {
      const literal = readQuotedLiteral(source, index, end);
      if (literal && literal.value === "model" && source[skipTrivia(source, literal.after, end)] === ":") {
        index = readModelPinValue(source, skipTrivia(source, literal.after, end) + 1, end, values);
        continue;
      }
      index = Math.min(skipQuotedString(source, index), end);
      continue;
    }
    if (character === "`") {
      const interpolationRanges = [];
      const afterTemplate = skipTemplateLiteral(source, index, interpolationRanges);
      for (const [interpolationStart, interpolationEnd] of interpolationRanges) {
        findModelPinValues(source, interpolationStart, interpolationEnd, values);
      }
      index = Math.min(afterTemplate, end);
      continue;
    }
    if (IDENTIFIER_CHAR_RE.test(character)) {
      let identifierEnd = index + 1;
      while (identifierEnd < end && IDENTIFIER_CHAR_RE.test(source[identifierEnd])) identifierEnd += 1;
      const afterKey = skipTrivia(source, identifierEnd, end);
      if (source.slice(index, identifierEnd) === "model" && source[afterKey] === ":") {
        index = readModelPinValue(source, afterKey + 1, end, values);
        continue;
      }
      index = identifierEnd;
      continue;
    }
    index += 1;
  }
}

function readModelPinValue(source, start, end, values) {
  const valueStart = skipTrivia(source, start, end);
  if (source[valueStart] === "'" || source[valueStart] === '"') {
    const literal = readQuotedLiteral(source, valueStart, end);
    if (literal) {
      values.push(literal.value);
      return literal.after;
    }
  }
  return Math.max(valueStart, start + 1);
}

function validateModel(value) {
  if (MODEL_ALIASES.test(value)) return;
  if (PREFIXED_ALIAS_RE.test(value)) {
    block(
      `lineage alias에는 claude-gateway-- prefix를 붙이면 안 됩니다: "${value}". ` +
        "alias는 그대로(fable|opus|sonnet|haiku) 사용하세요."
    );
  }
  if (value.startsWith(GATEWAY_MODEL_PREFIX)) return;
  block(
    `opts.model 값이 올바르지 않습니다: "${value}". gateway_models의 modelId(claude-gateway-- prefix 포함)를 ` +
      "그대로 복사하거나 lineage alias(fable|opus|sonnet|haiku)를 사용하세요."
  );
}

function callSnippet(source, call) {
  const end = call.close === -1 ? Math.min(source.length, call.start + 120) : call.close + 1;
  const snippet = source.slice(call.start, end).replace(/\s+/g, " ").trim();
  return snippet.length <= 120 ? snippet : `${snippet.slice(0, 117)}...`;
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const toolInput = input?.tool_input ?? {};
if (input?.tool_name && input.tool_name !== "Workflow") process.exit(0);

let script;
if (typeof toolInput.script === "string" && toolInput.script.length > 0) {
  script = toolInput.script;
} else if (typeof toolInput.scriptPath === "string" && toolInput.scriptPath.length > 0) {
  // resumeFromRunId 재실행은 scriptPath로 들어온다. 파일을 읽어 동일하게 검증한다.
  try {
    script = readFileSync(toolInput.scriptPath, "utf8");
  } catch {
    // 파일을 읽을 수 없으면 실행 단계에서 드러나는 오류이므로 여기서는 차단하지 않는다.
    process.exit(0);
  }
} else {
  // name(저장 워크플로우) 등 스크립트 내용을 볼 수 없는 호출은 검증할 수 없다. 통과시킨다.
  process.exit(0);
}

if (AGENT_TYPE_RE.test(script)) {
  block(
    "dynamic workflow 스크립트에 agentType이 금지됩니다. agentType은 팀메이트/서브에이전트 표면 전용이고, " +
      "워크플로우는 opts.model로만 팬아웃해야 합니다."
  );
}

const modelPinValues = [];
findModelPinValues(script, 0, script.length, modelPinValues);
for (const value of modelPinValues) {
  validateModel(value);
}

const calls = findAgentCalls(script);
for (const [index, call] of calls.entries()) {
  const model = findLiteralModelPin(script, call);
  if (model !== undefined) {
    validateModel(model);
    continue;
  }
  block(
    `${index + 1}번째 agent() 호출에 리터럴 opts.model pin이 없습니다: ${callSnippet(script, call)}. ` +
      "model을 지정하지 않은 agent() 호출은 세션 모델을 상속해 세션 자체 allowance를 소비하며, " +
      "이는 선택이 아니라 누락으로 도달합니다. opts.model에 lineage alias(fable|opus|sonnet|haiku) 또는 " +
      "gateway_models에서 claude-gateway-- prefix를 포함해 그대로 복사한 전체 modelId를 추가하세요."
  );
}

process.exit(0);
