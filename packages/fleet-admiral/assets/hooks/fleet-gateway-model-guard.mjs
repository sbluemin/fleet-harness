#!/usr/bin/env node
// Fleet gateway model guard — 게이트웨이 세션의 위임 정책을 코드로 강제하는 단일 훅.
//
// 이 저장소는 Admiral 시스템 프롬프트를 싣지 않는다. 위임 전에 로스터를 읽고 정체성을
// 핀하라는 지침이 상주 텍스트로 존재하지 않으므로, 그 역할 전부가 이 스크립트에 있다.
//
// 첫 인자가 서브커맨드다. 훅 이벤트마다 별도 파일을 두지 않는 이유는 세 판정이 같은
// 어휘(정체성 이름 / modelId / 접수증)를 공유하기 때문이다 — 파일을 쪼개면 그 어휘가
// 세 곳에서 따로 늙는다.
//
//   remind            UserPromptSubmit          매 턴 규약 주입 (무조건)
//   gate-delegation   PreToolUse  Agent|Workflow  핀되지 않은 위임을 차단
//   workflow-receipt  PostToolUse Workflow        접수증을 결과로 읽는 사고를 차단
//
// 상태를 남기지 않는다. 훅은 호출마다 새 프로세스로 뜨므로 프로세스 간 기억은 파일로만
// 가능한데, 그 파일은 곧 신선도·정리·경합을 떠안는 두 번째 진실이 된다. 세 판정 모두
// stdin 한 번으로 끝나도록 짰다 — 그래서 타임아웃으로 게이트가 조용히 열릴 여지도 작다.
import { readFileSync } from "node:fs";

// 아래 상주 텍스트와 block()이 내보내는 차단 사유는 모두 모델이 읽는다. 그래서 영어로 쓴다.
const TURN_REMINDER = [
  "Before any Agent or Workflow run leaves the host, call gateway_models and pin an identity from what it",
  "reports — allowances move while work is in flight.",
  "Agent: subagent_type = the fleet:* name. Workflow: opts.model = the modelId, the claude-gateway-- prefix",
  "included. The two spellings are never interchangeable.",
].join(" ");

const IN_FLIGHT_CONTRACT = [
  "This Workflow call returned a receipt, not a result. The run is still in flight and its result arrives later.",
  "End this turn with one status line: which surface, how many stages, and what you are waiting for.",
  "Do not review, conclude, summarize, or predict what the run will find — a reading written before the result is",
  "indistinguishable from the result to the reader, and it is still there after the real one lands.",
  "Report the finding once, in the turn the result arrives. If asked before then, say it is still running.",
].join(" ");

const PIN_INSTRUCTION = [
  "Call gateway_models first, then pin the identity it reports:",
  "Agent — subagent_type = the fleet:* name;",
  "Workflow — opts.model = the modelId with the claude-gateway-- prefix, written as a literal.",
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
const AGENT_TYPE_RE = /agentType\s*:/;
const MODEL_VALUE_RE = /model:\s*['"]([^'"]+)['"]/g;
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
      `opts.model is not a value this run can resolve: "${value}". Copy a modelId from gateway_models verbatim, ` +
        "the claude-gateway-- prefix included, or use a lineage alias (fable|opus|sonnet|haiku)."
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
      `${unpinned} agent() call(s) pin no model. ` +
        PIN_INSTRUCTION +
        " Spreading stages across models is the point of this surface, so assign one per role rather than " +
        "filling every stage with a single value."
    );
  }
  assertWorkflowModelValues(script);
  process.exit(0);
}

const subcommand = process.argv[2];

if (subcommand === "remind") {
  emitContext("UserPromptSubmit", TURN_REMINDER);
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
