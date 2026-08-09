// Claude의 Stop·SubagentStop hook payload에 실려 오는 background_tasks는 그 시점에 세션의 task registry에
// 등록된 작업 목록이다. 이것이 "턴보다 오래 남는 작업"의 유일한 절대 권위다.
//
// 세는 방식이 성립하지 않는 이유: Workflow 도구 호출 1건은 PreToolUse를 한 번만 발화하지만 SubagentStop은
// 워크플로우 에이전트 수만큼 발화한다. 그래서 spawn(+1)/stop(-1) 카운터는 첫 에이전트가 끝나는 순간 0이 되고,
// 나머지 에이전트가 아직 돌고 있는데도 백그라운드 배지가 꺼진다.
//
// SubagentStop payload의 agent_id는 지금 막 끝난 그 서브에이전트를 가리키며, 그 자신은 아직 목록에
// running으로 남아 있다. 따라서 자기 자신은 반드시 제외해야 한다. 반대로 워크플로우는 개별 에이전트가 아니라
// 워크플로우 하나가 항목 하나로 잡히므로, 소속 에이전트의 agent_id와는 절대 일치하지 않고 전량이 끝날 때까지 남는다.
//
// 그리고 끝난 작업이 목록에서 곧바로 빠진다는 보장은 없다. 이름 붙은 에이전트(teammate)는 다음 지시를 받으려고
// 세션에 상주하므로, 할 일을 마친 뒤에도 status: "running"인 채로 목록에 계속 잡힌다 — CLI 자신은 목록 밖의
// idle 표시로 이 둘을 가르지만 hook payload에는 그 표시가 실리지 않는다. 그래서 "끝났다"는 사실은 payload가
// 아니라 그 에이전트의 SubagentStop이 도착했다는 사건으로만 알 수 있고, 세션이 그 사건을 기억하지 않으면
// 다음 턴 종료 payload가 같은 상주 항목을 다시 살아 있는 작업으로 읽어 유휴·입력대기 전이를 통째로 막는다.
// 따라서 판정은 이미 stop을 보고한 agent id 집합을 함께 받아 제외하고, 갱신된 집합을 돌려준다.
//
// 셸 백그라운드 작업(type: "shell")은 세지 않는다. 이 축은 에이전트 작업 전용이고, 셸을 포함하면
// 긴 백그라운드 명령이 유휴 휴면까지 막게 된다.
const NON_AGENT_BACKGROUND_TASK_TYPES: ReadonlySet<string> = new Set(["shell"]);

const NO_SETTLED_AGENT_IDS: ReadonlySet<string> = new Set<string>();

// 목록도 읽지 못한 보고. 상태도 기억도 건드리지 않는다.
const NO_OPINION: BackgroundHookReport = { pending: undefined, settledAgentIds: undefined };

interface BackgroundHookPayload {
  readonly agent_id?: unknown;
  readonly background_tasks?: unknown;
}

interface BackgroundTaskEntry {
  readonly id?: unknown;
  readonly type?: unknown;
}

export interface BackgroundHookReport {
  /** 살아 있는 백그라운드 에이전트 작업이 남아 있는지. undefined는 무의견이다. */
  readonly pending: boolean | undefined;
  /** 세션이 이어서 기억할 "이미 stop을 보고한" agent id 집합. undefined면 기존 기억을 그대로 둔다. */
  readonly settledAgentIds: ReadonlySet<string> | undefined;
}

/**
 * hook payload(JSON 문자열)에서 이 세션에 백그라운드 에이전트 작업이 남아 있는지 판정한다.
 * 목록이나 그 안의 항목을 읽어낼 수 없으면 undefined(무의견)를 돌려 상태를 바꾸지 않게 한다 — 어휘가
 * 드리프트해도 거짓 유휴로 무너지는 대신 기존 상태와 TTL로 퇴보한다. 읽어내지 못한 항목은 "남은 작업이 없다"의
 * 근거가 될 수 없다. 다만 남아 있음이 확인된 항목이 하나라도 있으면 그것으로 이미 답이 정해지므로,
 * 같은 목록에 읽지 못한 항목이 섞여 있어도 true를 잃지 않는다.
 *
 * settledAgentIds는 직전까지 이 세션에서 stop을 보고한 agent id다. 그 항목은 상주 중일 뿐 일하지 않으므로
 * 살아 있는 작업으로 세지 않는다.
 */
export function readBackgroundHookReport(
  input: unknown,
  settledAgentIds: ReadonlySet<string> = NO_SETTLED_AGENT_IDS,
): BackgroundHookReport {
  if (typeof input !== "string" || input.length === 0) return NO_OPINION;
  let payload: BackgroundHookPayload;
  try {
    payload = JSON.parse(input) as BackgroundHookPayload;
  } catch {
    return NO_OPINION;
  }
  if (typeof payload !== "object" || payload === null) return NO_OPINION;
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return NO_OPINION;
  const selfAgentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  const listedIds = new Set<string>();
  let live = false;
  let unreadable = false;
  for (const task of tasks) {
    const entry = readTaskEntry(task);
    if (!entry) {
      unreadable = true;
      continue;
    }
    if (typeof entry.id === "string") listedIds.add(entry.id);
    if (isLiveAgentWork(entry, selfAgentId, settledAgentIds)) live = true;
  }
  if (!live && unreadable) return NO_OPINION;
  return {
    pending: live,
    settledAgentIds: nextSettledAgentIds({ settledAgentIds, selfAgentId, listedIds, listComplete: !unreadable }),
  };
}

// 항목 하나가 작업 레코드로 보이는지. 비-객체·null·배열은 알아볼 수 없는 값이다.
function readTaskEntry(task: unknown): BackgroundTaskEntry | null {
  if (typeof task !== "object" || task === null || Array.isArray(task)) return null;
  return task as BackgroundTaskEntry;
}

// 레코드이되 type만 없는 항목은 알아볼 수 없는 것이 아니라 denylist에 걸리지 않은 에이전트 작업으로 본다 —
// 새로 생기는 에이전트성 백그라운드 타입이 조용히 무시되지 않아야 하고, 그 방향이 거짓 유휴를 만들지 않는다.
function isLiveAgentWork(entry: BackgroundTaskEntry, selfAgentId: string | undefined, settledAgentIds: ReadonlySet<string>): boolean {
  if (typeof entry.id === "string" && (entry.id === selfAgentId || settledAgentIds.has(entry.id))) return false;
  return !(typeof entry.type === "string" && NON_AGENT_BACKGROUND_TASK_TYPES.has(entry.type));
}

// 기억은 목록이 지워준다. 목록을 전부 읽어낸 보고에서 더 이상 잡히지 않는 id는 registry에서 사라진 것이므로
// 버린다 — 이 가지치기가 없으면 세션이 사는 동안 id가 무한히 쌓인다. 못 읽은 항목이 섞인 보고는 사라졌다는
// 근거가 될 수 없으니 그때는 기존 기억을 그대로 둔다.
function nextSettledAgentIds({
  settledAgentIds,
  selfAgentId,
  listedIds,
  listComplete,
}: {
  readonly settledAgentIds: ReadonlySet<string>;
  readonly selfAgentId: string | undefined;
  readonly listedIds: ReadonlySet<string>;
  readonly listComplete: boolean;
}): ReadonlySet<string> {
  const next = new Set<string>();
  for (const id of settledAgentIds) {
    if (!listComplete || listedIds.has(id)) next.add(id);
  }
  if (selfAgentId !== undefined) next.add(selfAgentId);
  return next;
}
