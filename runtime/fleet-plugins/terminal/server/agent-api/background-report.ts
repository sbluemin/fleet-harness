// Claude의 Stop·SubagentStop hook payload에 실려 오는 background_tasks는 그 시점에 살아 있는 백그라운드
// 작업 전량이다(끝난 작업은 목록에서 빠진다). 이것이 "턴보다 오래 남는 작업"의 유일한 절대 권위다.
//
// 세는 방식이 성립하지 않는 이유: Workflow 도구 호출 1건은 PreToolUse를 한 번만 발화하지만 SubagentStop은
// 워크플로우 에이전트 수만큼 발화한다. 그래서 spawn(+1)/stop(-1) 카운터는 첫 에이전트가 끝나는 순간 0이 되고,
// 나머지 에이전트가 아직 돌고 있는데도 백그라운드 배지가 꺼진다.
//
// SubagentStop payload의 agent_id는 지금 막 끝난 그 서브에이전트를 가리키며, 그 자신은 아직 목록에
// running으로 남아 있다. 따라서 자기 자신은 반드시 제외해야 한다. 반대로 워크플로우는 개별 에이전트가 아니라
// 워크플로우 하나가 항목 하나로 잡히므로, 소속 에이전트의 agent_id와는 절대 일치하지 않고 전량이 끝날 때까지 남는다.
//
// 셸 백그라운드 작업(type: "shell")은 세지 않는다. 이 축은 에이전트 작업 전용이고, 셸을 포함하면
// 긴 백그라운드 명령이 유휴 휴면까지 막게 된다.
const NON_AGENT_BACKGROUND_TASK_TYPES: ReadonlySet<string> = new Set(["shell"]);

interface BackgroundHookPayload {
  readonly agent_id?: unknown;
  readonly background_tasks?: unknown;
}

/**
 * hook payload(JSON 문자열)에서 이 세션에 백그라운드 에이전트 작업이 남아 있는지 판정한다.
 * 목록이나 그 안의 항목을 읽어낼 수 없으면 undefined(무의견)를 돌려 상태를 바꾸지 않게 한다 — 어휘가
 * 드리프트해도 거짓 유휴로 무너지는 대신 기존 상태와 TTL로 퇴보한다. 읽어내지 못한 항목은 "남은 작업이 없다"의
 * 근거가 될 수 없다. 다만 남아 있음이 확인된 항목이 하나라도 있으면 그것으로 이미 답이 정해지므로,
 * 같은 목록에 읽지 못한 항목이 섞여 있어도 true를 잃지 않는다.
 */
export function resolveBackgroundPendingFromHookInput(input: unknown): boolean | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined;
  let payload: BackgroundHookPayload;
  try {
    payload = JSON.parse(input) as BackgroundHookPayload;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return undefined;
  const selfAgentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  let unreadable = false;
  for (const task of tasks) {
    const pending = classifyBackgroundTask(task, selfAgentId);
    if (pending === true) return true;
    if (pending === undefined) unreadable = true;
  }
  return unreadable ? undefined : false;
}

// 항목 하나의 판정. 작업 레코드로 보이지 않는 값(비-객체·null·배열)은 undefined(무의견)다.
// 반면 레코드이되 type만 없는 항목은 알아볼 수 없는 것이 아니라 denylist에 걸리지 않은 에이전트 작업으로 본다 —
// 새로 생기는 에이전트성 백그라운드 타입이 조용히 무시되지 않아야 하고, 그 방향이 거짓 유휴를 만들지 않는다.
function classifyBackgroundTask(task: unknown, selfAgentId: string | undefined): boolean | undefined {
  if (typeof task !== "object" || task === null || Array.isArray(task)) return undefined;
  const entry = task as { readonly id?: unknown; readonly type?: unknown };
  if (selfAgentId !== undefined && entry.id === selfAgentId) return false;
  return !(typeof entry.type === "string" && NON_AGENT_BACKGROUND_TASK_TYPES.has(entry.type));
}
