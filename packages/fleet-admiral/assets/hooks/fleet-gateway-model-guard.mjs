#!/usr/bin/env node
// Fleet gateway model guard — 게이트웨이 세션의 위임 정책을 코드로 강제하는 단일 훅.
//
// 이 저장소는 Admiral 시스템 프롬프트를 싣지 않는다. 매 턴에는 위임·병렬 작업을
// orchestration 스킬로 라우팅하는 짧은 트립와이어만 주입한다. 스킬이 돌아온 뒤의 훅이
// 실시간 로스터와 핀 문법을 제공하고, 디스패치 직전의 이 훅은 그 형식을 하드 게이트로 검증한다.
//
// 첫 인자가 서브커맨드다. 훅 이벤트마다 별도 파일을 두지 않는 이유는 네 판정이 같은
// 어휘(오케스트레이션 스킬 / 정체성 이름 / modelId / 접수증)를 공유하기 때문이다 — 파일을
// 쪼개면 그 어휘가 여러 곳에서 따로 늙는다.
//
//   remind                 UserPromptSubmit           위임·병렬 작업을 orchestration 스킬로 라우팅
//   begin-orchestration    PreToolUse Skill            이전 refresh receipt를 폐기
//   gate-delegation        PreToolUse Agent|Workflow   핀되지 않은 위임을 차단
//   workflow-receipt       PostToolUse Workflow         접수증을 결과로 읽는 사고를 차단
//   orchestration-failed   PostToolUseFailure Skill     로스터가 주입되지 않았음을 명시
//   cleanup-routing        SessionEnd                   이 런치의 receipt를 정리
//
// 핀 형식 판정은 stdin 한 번으로 끝난다. gateway 위임만 예외로, 성공한 MCP refresh가 쓴
// prompt-scoped private receipt를 PreToolUse가 검증한다. orchestration을 다시 열 때 먼저 폐기해
// 뒤이은 refresh 실패가 앞선 성공으로 가려지지 않는다. receipt가 없거나 다른 세션/런치의 것이면
// fail-closed하므로 non-blocking MCP 오류가 stale identity dispatch로 바뀌지 않는다.
import { closeSync, constants, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 아래 상주 텍스트와 block()이 내보내는 차단 사유는 모두 모델이 읽는다. 그래서 영어로 쓴다.
const TURN_REMINDER = [
  "If handling this request requires delegation or a parallel workload, invoke the fleet:orchestration skill",
  "before calling Agent or Workflow. Its completion supplies the live routing context for the handoff.",
  "Do not delegate implementation by default; keep it on the host unless the skill's narrow mechanical exception applies.",
].join(" ");

const ORCHESTRATION_FAILURE = [
  "fleet:orchestration did not complete, so no live routing context was supplied.",
  "Keep the work on the host or invoke the skill again; do not guess an identity or dispatch from stale context.",
].join(" ");

const IN_FLIGHT_CONTRACT = [
  "This Workflow call returned a receipt, not a result. The run is still in flight and its result arrives later.",
  "End this turn with one status line: which surface, how many stages, and what you are waiting for.",
  "Do not review, conclude, summarize, or predict what the run will find — a reading written before the result is",
  "indistinguishable from the result to the reader, and it is still there after the real one lands.",
  "Report the finding once, in the turn the result arrives. If asked before then, say it is still running.",
].join(" ");

const PIN_INSTRUCTION = [
  "Invoke fleet:orchestration and use the live routing context its completion supplies:",
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
const ROUTING_RECEIPT_ROOT = process.env.FLEET_ROUTING_RECEIPT_ROOT || path.join(os.tmpdir(), "fleet-routing-receipts");
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
  const gatewayModels = [];
  for (const match of script.matchAll(MODEL_VALUE_RE)) {
    const value = match[1];
    if (MODEL_ALIASES.test(value)) continue;
    if (PREFIXED_ALIAS_RE.test(value)) {
      block(
        `A lineage alias must not carry the claude-gateway-- prefix: "${value}". ` +
          "Write the alias bare (fable|opus|sonnet|haiku)."
      );
    }
    if (value.startsWith(GATEWAY_MODEL_PREFIX)) {
      gatewayModels.push(value);
      continue;
    }
    block(
      `opts.model is not a value this run can resolve: "${value}". Copy a modelId from gateway_models verbatim, ` +
        "the claude-gateway-- prefix included, or use a lineage alias (fable|opus|sonnet|haiku)."
    );
  }
  return gatewayModels;
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

function routingReceiptPath(input, routingNonce) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  if (!sessionId || !routingNonce) return undefined;
  const key = [sessionId, routingNonce]
    .map((part) => Buffer.from(part, "utf8").toString("base64url"))
    .join(".");
  return path.join(ROUTING_RECEIPT_ROOT, `${key}.json`);
}

function removeRoutingReceipt(input, routingNonce) {
  const receiptPath = routingReceiptPath(input, routingNonce);
  if (receiptPath === undefined) return;
  try {
    rmSync(receiptPath, { force: true });
  } catch {
    // Cleanup is best effort. A later gateway dispatch still verifies prompt_id from the receipt payload.
  }
}

function readRoutingReceipt(input, routingNonce) {
  const receiptPath = routingReceiptPath(input, routingNonce);
  const promptId = typeof input.prompt_id === "string" ? input.prompt_id : undefined;
  if (receiptPath === undefined || !promptId) {
    block(
      "This gateway delegation has no prompt-scoped routing receipt. Invoke fleet:orchestration again; " +
        "do not dispatch from stale routing context."
    );
  }
  let fd;
  let receipt;
  try {
    fd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    receipt = JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    block(
      "The live gateway roster refresh did not complete for this handoff. Keep the work on the host or " +
        "invoke fleet:orchestration again; do not guess an identity."
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (receipt.promptId !== promptId) {
    block(
      "The live gateway roster refresh did not complete for this handoff. Keep the work on the host or " +
        "invoke fleet:orchestration again; do not guess an identity."
    );
  }
  return {
    agentTypes: new Set(Array.isArray(receipt.agentTypes) ? receipt.agentTypes.filter((value) => typeof value === "string") : []),
    modelIds: new Set(Array.isArray(receipt.modelIds) ? receipt.modelIds.filter((value) => typeof value === "string") : []),
  };
}

function gateAgentDelegation(toolInput, input, routingNonce) {
  const agentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
  if (agentType !== undefined && agentType.startsWith(GATEWAY_AGENT_PREFIX)) {
    const receipt = readRoutingReceipt(input, routingNonce);
    if (!receipt.agentTypes.has(agentType)) {
      block(
        `subagent_type is not in the fresh gateway roster: "${agentType}". ` +
          "Invoke fleet:orchestration again or keep the work on the host."
      );
    }
    process.exit(0);
  }
  if (agentType !== undefined && !UNPINNED_AGENT_TYPES.has(agentType)) process.exit(0);
  block(
    `This delegation pins no identity (subagent_type: ${agentType ?? "absent"}). ` + PIN_INSTRUCTION
  );
}

function gateWorkflowDelegation(toolInput, input, routingNonce) {
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
  const gatewayModels = assertWorkflowModelValues(script);
  if (gatewayModels.length > 0) {
    const receipt = readRoutingReceipt(input, routingNonce);
    const stale = gatewayModels.find((modelId) => !receipt.modelIds.has(modelId));
    if (stale !== undefined) {
      block(
        `opts.model is not in the fresh gateway roster: "${stale}". ` +
          "Invoke fleet:orchestration again or keep the work on the host."
      );
    }
  }
  process.exit(0);
}

const subcommand = process.argv[2];
const routingNonce = process.argv[3];

if (subcommand === "remind") {
  emitContext("UserPromptSubmit", TURN_REMINDER);
}

const input = readHookInput();
const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};

if (subcommand === "begin-orchestration") {
  if (toolName !== "Skill" || toolInput.skill !== "fleet:orchestration") process.exit(0);
  removeRoutingReceipt(input, routingNonce);
  process.exit(0);
}

if (subcommand === "cleanup-routing") {
  removeRoutingReceipt(input, routingNonce);
  process.exit(0);
}

if (subcommand === "workflow-receipt") {
  if (toolName !== "Workflow") process.exit(0);
  emitContext("PostToolUse", IN_FLIGHT_CONTRACT);
}

if (subcommand === "orchestration-failed") {
  if (toolName !== "Skill" || toolInput.skill !== "fleet:orchestration") process.exit(0);
  emitContext("PostToolUseFailure", ORCHESTRATION_FAILURE);
}

if (subcommand === "gate-delegation") {
  if (toolName === "Agent") gateAgentDelegation(toolInput, input, routingNonce);
  if (toolName === "Workflow") gateWorkflowDelegation(toolInput, input, routingNonce);
  process.exit(0);
}

process.exit(0);
