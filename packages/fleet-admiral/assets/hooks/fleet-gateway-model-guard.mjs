#!/usr/bin/env node
// Fleet gateway model guard — 게이트웨이 세션의 위임 정책을 코드로 강제하는 단일 훅.
//
// 이 저장소는 Admiral 시스템 프롬프트를 싣지 않고, 매 턴 주입도 하지 않는다. 위임·병렬 작업을
// delegation 스킬로 보내는 라우팅은 스킬 description의 When-to-use 트리거가 소유한다 — 한때
// UserPromptSubmit `remind` 주입이 그 라우팅을 맡았으나, 스킬이 호출되지 않던 원인은 주입의
// 부재가 아니라 추상적인 description이었으므로 상주 문맥만 남기는 주입은 제거했다. 스킬은 의미
// 정책만 소유하고, 핀에 쓸 수 있는 이름은 gateway_models 응답에만 있으며, 디스패치 직전의 이
// 훅은 그 결과의 형식을 하드 게이트로 검증한다.
//
// 로스터 주입을 훅으로 하지 않는 이유: Claude Code의 `if` 조건은 퍼미션 룰 문법으로 평가되고
// 룰 콘텐츠 매칭은 도구의 preparePermissionMatcher에 의존한다. Skill 도구에는 그 매처가 없어
// `Skill(<name>)` 조건은 항상 거짓이 되고, 그 조건을 단 훅은 verbose 로그 한 줄만 남기고 조용히
// 스킵된다. 스킬 전후에 훅을 걸어 문맥을 주입하는 설계는 그래서 성립하지 않는다 — 대신 호스트가
// 직접 도구를 호출하게 한다.
//
// 첫 인자가 서브커맨드다. 훅 이벤트마다 별도 파일을 두지 않는 이유는 두 판정이 같은 어휘
// (정체성 이름 / modelId)를 공유하기 때문이다 — 파일을 쪼개면 그 어휘가 여러 곳에서 따로 늙는다.
//
//   plugin-version <ver>   SessionStart               이 세션이 시작할 때 렌더된 플러그인 버전
//   gate-delegation        PreToolUse Agent|Workflow   핀되지 않은 위임을 차단
//   workflow-receipt       PostToolUse Workflow         접수증을 결과로 읽는 사고를 차단
//
// 판정은 stdin 한 번으로 끝난다. 이 훅은 핀의 형식만 본다 — 이름이 실제로 이 세션에서 해석되는지는
// 디스패치가 판정하며, 그 판정을 미리 흉내 내려면 호스트가 읽은 로스터를 훅이 다시 읽어야 하므로
// 같은 사실이 두 곳에서 따로 늙는다.
import { readFileSync } from "node:fs";

// 아래 상주 텍스트와 block()이 내보내는 차단 사유는 모두 모델이 읽는다. 그래서 영어로 쓴다.
const IN_FLIGHT_CONTRACT = [
  "This Workflow call returned a receipt, not a result. The run is still in flight and its result arrives later.",
  "End this turn with one status line: which surface, how many stages, and what you are waiting for.",
  "Do not review, conclude, summarize, or predict what the run will find — a reading written before the result is",
  "indistinguishable from the result to the reader, and it is still there after the real one lands.",
  "Report the finding once, in the turn the result arrives. If asked before then, say it is still running.",
].join(" ");

const PIN_INSTRUCTION = [
  "Read the live roster with the fleet gateway_models tool and pin from what it returns:",
  "Agent — subagent_type = an agentTypes value;",
  "Workflow — opts.model = a modelId with the claude-gateway-- prefix, written as a literal.",
].join(" ");

/**
 * 한 값은 한 모델만 가리킨다는 사실과, 흩뿌리기가 로스터 크기에 달렸다는 사실.
 *
 * "역할마다 다른 모델"만 말하면 노출 모델이 하나인 세션에서 지킬 방법이 없고, 그러면 값 안에
 * 프로바이더나 강도를 끼워 넣어 다양성을 흉내 내는 문자열이 나온다(실제로 `grok-4.6 (xai/cursor)
 * @high`가 나왔다). 그래서 두 문장을 붙여 둔다 — 몇 개일 때 무엇을 하는지, 그리고 값에 무엇을
 * 넣으면 안 되는지.
 */
const STAGE_SPREAD_GUIDANCE = [
  "When the roster exposes several models, assign them across the stages by role;",
  "when it exposes one, pin that one to every stage — never invent variety inside the value.",
  "A modelId names one model and nothing else: its provider is already part of it,",
  "and a reasoning rung is the separate effort option.",
].join(" ");

/**
 * 이 검사가 스크립트 어디를 보는지.
 *
 * 값 스캔은 원문 전체를 훑으므로 `meta.phases[].model`도 함께 걸린다. 그런데 거절 사유가
 * `opts.model`을 특정하면 호스트는 멀쩡한 스테이지 핀을 들여다보며 시간을 쓴다 — 실제로
 * `meta.phases`에 사람이 읽는 라벨을 적었다가 엉뚱한 필드를 지목받은 사례가 있었다. 그래서
 * 필드를 특정하지 않고, 대신 어디까지가 판정 대상인지를 말한다.
 */
const SCANNED_FIELDS = [
  "Every model: value in the script is judged, a meta.phases entry's included —",
  "leave that field out unless it names the same model its stages pin.",
].join(" ");

/**
 * 정체성이 핀되지 않은 위임으로 취급하는 Agent 타입.
 *
 * 내장 전문 에이전트(Explore/Plan/…)와 fork는 통과시킨다. fork는 부모 컨텍스트를 잇는 것이
 * 목적이라 다른 모델로 옮기는 것 자체가 그 표면의 의미를 없애고, 나머지는 그 도구를 쓰려고
 * 고른 이름이지 위임을 미룬 결과가 아니다. 아래 둘만이 "아무것도 고르지 않았다"의 철자다.
 */
const UNPINNED_AGENT_TYPES = new Set(["general-purpose", "claude"]);

const GATEWAY_AGENT_PREFIX = "fleet:";
const MODEL_ALIASES = /^(fable|opus|sonnet|haiku)$/;
const PREFIXED_ALIAS_RE = /^claude-gateway--(fable|opus|sonnet|haiku)$/;
const GATEWAY_MODEL_PREFIX = "claude-gateway--";
// `subagentType:` 같은 접미 식별자를 opts.agentType으로 읽으면 멀쩡한 스크립트가 막힌다.
const AGENT_TYPE_RE = /\bagentType\s*:/;
// 핀 인식(`\bmodel\s*:`)과 값 검증은 같은 철자를 봐야 한다. 경계나 공백 하나가 어긋나면
// `{ model : "..." }`가 핀으로 세어지고도 검증을 건너뛰고, `response_model:` 같은 설정 키가
// opts.model로 오인되어 멀쩡한 스크립트가 막힌다.
const MODEL_VALUE_RE = /\bmodel\s*:\s*['"]([^'"]+)['"]/g;
const AGENT_CALL_RE = /\bagent\s*\(/g;

function block(message) {
  process.stderr.write(`[fleet-gateway-model-guard] ${message}\n`);
  process.exit(2);
}

function emitContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // 입력을 읽지 못하면 판정할 근거가 없다. 차단은 근거가 있을 때만 한다.
    process.exit(0);
  }
}

/**
 * `agent(` 호출 하나가 차지하는 원문 범위. 괄호 균형으로 끝을 찾되 문자열·주석 안의 괄호는
 * 세지 않는다 — 프롬프트 텍스트에 괄호가 흔해서, 세는 순간 호출 경계가 엉뚱한 곳에서 닫힌다.
 *
 * 끝을 찾지 못하면 undefined를 돌려주고 호출자는 그 호출을 검사하지 않는다. 이 스캐너는
 * 파서가 아니므로, 판정할 수 없는 형태를 "핀 없음"으로 몰아 멀쩡한 스크립트를 막는 쪽이
 * 검사 한 건을 놓치는 쪽보다 나쁘다.
 */
function sliceCall(script, openParenIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let i = openParenIndex; i < script.length; i += 1) {
    const char = script[i];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && script[i + 1] === "/") {
      const lineEnd = script.indexOf("\n", i);
      if (lineEnd === -1) return undefined;
      i = lineEnd;
      continue;
    }
    if (char === "/" && script[i + 1] === "*") {
      const blockEnd = script.indexOf("*/", i + 2);
      if (blockEnd === -1) return undefined;
      i = blockEnd + 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return script.slice(openParenIndex, i + 1);
    }
  }
  return undefined;
}

/** model 옵션이 없는 `agent(` 호출의 개수. 경계를 못 읽은 호출은 세지 않는다. */
function countUnpinnedAgentCalls(script) {
  let unpinned = 0;
  for (const match of script.matchAll(AGENT_CALL_RE)) {
    const call = sliceCall(script, match.index + match[0].length - 1);
    if (call === undefined) continue;
    if (!/\bmodel\s*:/.test(call)) unpinned += 1;
  }
  return unpinned;
}

function assertWorkflowModelValues(script) {
  for (const match of script.matchAll(MODEL_VALUE_RE)) {
    const value = match[1];
    if (MODEL_ALIASES.test(value)) continue;
    if (PREFIXED_ALIAS_RE.test(value)) {
      block(
        `A lineage alias must not carry the claude-gateway-- prefix: "${value}". ` +
          "Write the alias bare (fable|opus|sonnet|haiku)."
      );
    }
    if (value.startsWith(GATEWAY_MODEL_PREFIX)) continue;
    block(
      `A model value in this script is not one this run can resolve: "${value}". ` +
        SCANNED_FIELDS +
        " Copy a modelId from gateway_models verbatim, the claude-gateway-- prefix included, " +
        "or use a lineage alias (fable|opus|sonnet|haiku). " +
        STAGE_SPREAD_GUIDANCE
    );
  }
}

/** 검사 대상 스크립트 원문. 볼 수 없는 호출 형태는 undefined를 돌려준다. */
function resolveWorkflowScript(toolInput) {
  if (typeof toolInput.script === "string" && toolInput.script.length > 0) return toolInput.script;
  // resumeFromRunId 재실행은 scriptPath로 들어온다. 파일을 읽어 동일하게 검증한다.
  if (typeof toolInput.scriptPath === "string" && toolInput.scriptPath.length > 0) {
    try {
      return readFileSync(toolInput.scriptPath, "utf8");
    } catch {
      // 파일을 읽을 수 없으면 실행 단계에서 드러나는 오류다. 여기서는 판정하지 않는다.
      return undefined;
    }
  }
  // name(저장 워크플로우)은 내용을 볼 수 없다. 사전 검증된 것으로 신뢰한다.
  return undefined;
}

function gateAgentDelegation(toolInput) {
  const agentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
  if (agentType !== undefined && agentType.startsWith(GATEWAY_AGENT_PREFIX)) process.exit(0);
  if (agentType !== undefined && !UNPINNED_AGENT_TYPES.has(agentType)) process.exit(0);
  block(
    `This delegation pins no identity (subagent_type: ${agentType ?? "absent"}). ` + PIN_INSTRUCTION
  );
}

function gateWorkflowDelegation(toolInput) {
  const script = resolveWorkflowScript(toolInput);
  if (script === undefined) process.exit(0);
  if (AGENT_TYPE_RE.test(script)) {
    block(
      "agentType is not allowed in a dynamic workflow script. It belongs to the teammate and subagent surfaces; " +
        "a workflow fans out through opts.model alone."
    );
  }
  const unpinned = countUnpinnedAgentCalls(script);
  if (unpinned > 0) {
    block(
      `${unpinned} agent() call(s) pin no model. ` + PIN_INSTRUCTION + " " + STAGE_SPREAD_GUIDANCE
    );
  }
  assertWorkflowModelValues(script);
  process.exit(0);
}

const subcommand = process.argv[2];

if (subcommand === "plugin-version") {
  const version = process.argv[3];
  if (version) emitContext("SessionStart", `Fleet plugin version: ${version}`);
  process.exit(0);
}

const input = readHookInput();
const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};

if (subcommand === "workflow-receipt") {
  if (toolName !== "Workflow") process.exit(0);
  emitContext("PostToolUse", IN_FLIGHT_CONTRACT);
}

if (subcommand === "gate-delegation") {
  if (toolName === "Agent") gateAgentDelegation(toolInput);
  if (toolName === "Workflow") gateWorkflowDelegation(toolInput);
  process.exit(0);
}

process.exit(0);
