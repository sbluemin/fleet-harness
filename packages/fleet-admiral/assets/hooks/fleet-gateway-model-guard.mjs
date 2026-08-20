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
//   gate-delegation   PreToolUse  Agent|Workflow  Agent의 핀 누락과 workflow의 틀린 모델 철자를 차단
//   workflow-receipt  PostToolUse Workflow        접수증을 결과로 읽는 사고를 차단
//
// 상태를 남기지 않는다. 훅은 호출마다 새 프로세스로 뜨므로 프로세스 간 기억은 파일로만
// 가능한데, 그 파일은 곧 신선도·정리·경합을 떠안는 두 번째 진실이 된다. 세 판정 모두
// stdin 한 번으로 끝나도록 짰다 — 그래서 타임아웃으로 게이트가 조용히 열릴 여지도 작다.
import { readFileSync } from "node:fs";

// 모델에게 주는 지시이므로 영어로 쓴다.
const TURN_REMINDER = [
  "Before any Agent run leaves the host, call gateway_models and pin an identity from what it reports —",
  "allowances move while work is in flight. Agent: subagent_type = the fleet:* name.",
  "A Workflow stage may stay on the host model; when you do move one, opts.model takes the modelId with the",
  "claude-gateway-- prefix and opts.agentType takes the fleet:* name. The spellings are never interchangeable.",
].join(" ");

const IN_FLIGHT_CONTRACT = [
  "This Workflow call returned a receipt, not a result. The run is still in flight and its result arrives later.",
  "End this turn with one status line: which surface, how many stages, and what you are waiting for.",
  "Do not review, conclude, summarize, or predict what the run will find — a reading written before the result is",
  "indistinguishable from the result to the reader, and it is still there after the real one lands.",
  "Report the finding once, in the turn the result arrives. If asked before then, say it is still running.",
].join(" ");

const PIN_INSTRUCTION =
  "Call gateway_models first, then pin the identity it reports: subagent_type = the fleet:* name.";

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
const MODEL_VALUE_RE = /model:\s*['"]([^'"]+)['"]/g;

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
 * 워크플로우가 쓴 모델 값의 철자 검사.
 *
 * 스테이지를 옮길지 말지는 호스트가 정한다 — 핀하지 않은 스테이지는 세션 모델로 돌면 그만이다.
 * 여기서 막는 것은 옮기기로 해놓고 값을 잘못 쓴 경우뿐이다. 로스터 이름이나 prefix가 빠진
 * modelId가 `model` 자리에 들어가면 모든 분기가 시작 즉시 죽으므로, 그 실패는 실행 전에 잡는
 * 편이 훨씬 싸다.
 */
function assertWorkflowModelValues(script) {
  for (const match of script.matchAll(MODEL_VALUE_RE)) {
    const value = match[1];
    if (MODEL_ALIASES.test(value)) continue;
    if (PREFIXED_ALIAS_RE.test(value)) {
      block(
        `lineage alias에는 claude-gateway-- prefix를 붙이면 안 됩니다: "${value}". ` +
          "alias는 그대로(fable|opus|sonnet|haiku) 사용하세요."
      );
    }
    if (value.startsWith(GATEWAY_MODEL_PREFIX)) continue;
    block(
      `opts.model 값이 올바르지 않습니다: "${value}". gateway_models의 modelId(claude-gateway-- prefix 포함)를 ` +
        "그대로 복사하거나 lineage alias(fable|opus|sonnet|haiku)를 사용하세요. " +
        "fleet:* 이름은 opts.agentType 자리입니다."
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
    `이 위임은 정체성이 핀되지 않았습니다(subagent_type: ${agentType ?? "미지정"}). ` +
      PIN_INSTRUCTION
  );
}

function gateWorkflowDelegation(toolInput) {
  const script = resolveWorkflowScript(toolInput);
  if (script === undefined) process.exit(0);
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
