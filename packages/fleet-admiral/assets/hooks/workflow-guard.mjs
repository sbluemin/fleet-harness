#!/usr/bin/env node
// Fleet workflow model guard — Admiral 정책 게이트 (PreToolUse, matcher: Workflow).
//
// dynamic workflow 스크립트를 디스패치하기 전에 검증해 두 가지 사고를 차단한다:
//   1. opts.agentType 사용 (금지 — agentType은 팀메이트/서브에이전트 표면 전용)
//   2. opts.model 값이 lineage alias도, claude-gateway-- 접두 modelId도 아닌 경우
//      (gateway_models의 modelId에서 claude-gateway-- prefix를 누락한 사고)
//
// stdin으로 PreToolUse 훅 입력 JSON({ tool_name, tool_input, ... })을 받고,
// 위반 시 stderr에 사유를 쓰고 exit 2로 호출을 차단한다. 통과 시 exit 0.
// 백그라운드 활동 카운팅 신호가 아니므로 호스트로 어떤 신호도 보내지 않는다.
import { readFileSync } from "node:fs";

const MODEL_ALIASES = /^(fable|opus|sonnet|haiku)$/;
const PREFIXED_ALIAS_RE = /^claude-gateway--(fable|opus|sonnet|haiku)$/;
const GATEWAY_MODEL_PREFIX = "claude-gateway--";
const AGENT_TYPE_RE = /agentType\s*:/;
const MODEL_RE = /model:\s*['"]([^'"]+)['"]/g;

function block(message) {
  process.stderr.write(`[workflow-guard] ${message}\n`);
  process.exit(2);
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

for (const match of script.matchAll(MODEL_RE)) {
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
      "그대로 복사하거나 lineage alias(fable|opus|sonnet|haiku)를 사용하세요."
  );
}

process.exit(0);
