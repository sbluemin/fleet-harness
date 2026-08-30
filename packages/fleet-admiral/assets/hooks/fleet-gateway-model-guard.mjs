#!/usr/bin/env node
// Fleet gateway model guard — 게이트웨이 세션의 Workflow 접수증 계약을 싣는 훅.
//
// 이 저장소는 Admiral 시스템 프롬프트를 싣지 않고, 매 턴 주입도, 디스패치 게이트도 두지 않는다.
// 위임·병렬 작업을 delegation 스킬로 보내는 라우팅은 스킬 description의 When-to-use 트리거가,
// 디스패치별 정체성 선택은 스킬 본문의 의미 정책이, 철자와 로스터는 gateway_models 응답이
// 소유한다.
//
// 한때 이 파일의 `remind`(UserPromptSubmit)가 라우팅을, `gate-delegation`(PreToolUse
// Agent|Workflow)이 핀 철자 검증을 맡았다. 라우팅 실패의 원인은 주입의 부재가 아니라 추상적인
// description이었고, 게이트는 철자만 볼 수 있는데(해석 여부는 어차피 디스패처 판정) 그 유사
// 파서가 멀쩡한 스크립트를 반복해서 막았다(`response_model:` 설정 키 오인·`meta.phases` 라벨
// 지목·콜론 앞 공백). 결정타는 살아 있는 Workflow 계약이다: `agent()` opts는 Agent 도구와 같은
// 레지스트리에서 해석되는 `agentType` 핀을 정식 지원하고, `model`은 생략하면 세션 모델을
// 상속하는 것이 기본이라고 스스로 문서화한다 — "모든 스테이지 강제 핀"은 런타임 자신의 문법과
// 싸우는 독트린이 되어 퇴역했다. 철자 게이트를 되살리면 같은 거짓 차단이 돌아온다.
//
// 로스터 주입을 훅으로 하지 않는 이유: Claude Code의 `if` 조건은 퍼미션 룰 문법으로 평가되고
// 룰 콘텐츠 매칭은 도구의 preparePermissionMatcher에 의존한다. Skill 도구에는 그 매처가 없어
// `Skill(<name>)` 조건은 항상 거짓이 되고, 그 조건을 단 훅은 verbose 로그 한 줄만 남기고 조용히
// 스킵된다. 스킬 전후에 훅을 걸어 문맥을 주입하는 설계는 그래서 성립하지 않는다 — 대신 호스트가
// 직접 도구를 호출하게 한다.
//
// 첫 인자가 서브커맨드다. 퇴역한 서브커맨드(remind·gate-delegation)는 알 수 없는 이름으로
// 들어와도 판정 없이 exit 0으로 끝난다 — 공유 플러그인 트리는 in-place 교체라 실행 중 세션이
// 다음 이벤트부터 이 스크립트를 실행하므로, 낡은 hooks.json이 턴을 오류로 물들이거나 디스패치를
// 막으면 안 된다.
//
//   plugin-version <ver>   SessionStart          이 세션이 시작할 때 렌더된 플러그인 버전
//   workflow-receipt       PostToolUse Workflow   접수증을 결과로 읽는 사고를 차단
import { readFileSync } from "node:fs";

// 아래 상주 텍스트는 모델이 읽는다. 그래서 영어로 쓴다.
const IN_FLIGHT_CONTRACT = [
  "This Workflow call returned a receipt, not a result. The run is still in flight and its result arrives later.",
  "End this turn with one status line: which surface, how many stages, and what you are waiting for.",
  "Do not review, conclude, summarize, or predict what the run will find — a reading written before the result is",
  "indistinguishable from the result to the reader, and it is still there after the real one lands.",
  "Report the finding once, in the turn the result arrives. If asked before then, say it is still running.",
].join(" ");

function emitContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // 입력을 읽지 못하면 판정할 근거가 없다. 문맥 추가는 근거가 있을 때만 한다.
    process.exit(0);
  }
}

const subcommand = process.argv[2];

if (subcommand === "plugin-version") {
  const version = process.argv[3];
  if (version) emitContext("SessionStart", `Fleet plugin version: ${version}`);
  process.exit(0);
}

const input = readHookInput();
const toolName = input?.tool_name;

if (subcommand === "workflow-receipt") {
  if (toolName !== "Workflow") process.exit(0);
  emitContext("PostToolUse", IN_FLIGHT_CONTRACT);
}

process.exit(0);
