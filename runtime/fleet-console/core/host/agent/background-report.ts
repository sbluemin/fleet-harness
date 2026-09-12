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
// 이 축에 서는 것은 에이전트 작업뿐이다 — 서브에이전트, 이름 붙은 팀메이트, 워크플로우. 그 셋만 센다.
//
// 부정 목록(셸만 빼기)이 아니라 양쪽을 다 적는 이유는, 뺄 것이 셸 하나가 아니기 때문이다. 서브에이전트가
// 띄운 백그라운드 셸은 그 서브에이전트가 끝난 뒤에도 부모 세션의 목록에 남고(2026-08-18 실측), MCP 감시
// 작업은 세션이 사는 내내 상주한다. 어느 쪽이든 이 축에 세우면 유휴·입력 대기 전이와 유휴 휴면이 통째로
// 막힌다 — 사람이 기다리는 것은 자기 일을 대신 하는 에이전트이지, 그 에이전트가 남긴 명령이 아니다.
//
// 라벨은 실측이다: `shell`·`subagent`(2026-08-18, Claude Code 2.1.234), `workflow`·`teammate`
// (2.1.224~2.1.226, 아래 테스트 픽스처). `monitor`는 SDK 선언이 예로 드는 MCP 작업 라벨이다.
const AGENT_BACKGROUND_TASK_TYPES: ReadonlySet<string> = new Set(["subagent", "teammate", "workflow"]);
const NON_AGENT_BACKGROUND_TASK_TYPES: ReadonlySet<string> = new Set(["shell", "monitor"]);

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
  // 두 축은 다른 질문에 답한다. 하나는 "이 항목이 살아 있는 에이전트 작업인가"이고, 다른 하나는
  // "이 목록에서 id를 전부 거두었는가"다. 처음 보는 종류는 앞의 답을 모르지만 id는 읽었으므로,
  // 두 축을 한 깃발로 묶으면 그런 항목 하나가 기억의 가지치기를 영영 막아 상주 에이전트가 세션이
  // 끝날 때까지 제외된 채로 남는다.
  let workUnknown = false;
  let listIncomplete = false;
  for (const task of tasks) {
    const entry = readTaskEntry(task);
    if (!entry) {
      workUnknown = true;
      listIncomplete = true;
      continue;
    }
    if (typeof entry.id === "string") listedIds.add(entry.id);
    else listIncomplete = true;
    const verdict = classifyBackgroundTask(entry, selfAgentId, settledAgentIds);
    if (verdict === "live") live = true;
    else if (verdict === "unreadable") workUnknown = true;
  }
  if (!live && workUnknown) return NO_OPINION;
  return {
    pending: live,
    settledAgentIds: nextSettledAgentIds({ settledAgentIds, selfAgentId, listedIds, listComplete: !listIncomplete }),
  };
}

// 항목 하나가 작업 레코드로 보이는지. 비-객체·null·배열은 알아볼 수 없는 값이다.
function readTaskEntry(task: unknown): BackgroundTaskEntry | null {
  if (typeof task !== "object" || task === null || Array.isArray(task)) return null;
  return task as BackgroundTaskEntry;
}

// 항목 하나의 판정. 어느 목록에도 없는 type과 type이 아예 없는 레코드는 "에이전트 작업 없음"의 근거가 되지
// 못하므로 알아보지 못한 것으로 남긴다.
//
// 이 무의견은 앞선 값을 지키는 것이지 새 값을 세우는 것이 아니다. 처음 보는 종류만 남은 목록이 그 세션의
// 첫 보고라면 배지는 서지 않은 채로 남는다 — 이 축이 서지 않는 것은 기능이 없던 상태와 같고, 알아보지도
// 못한 것을 에이전트 작업으로 세우면 셸·감시 작업이 축을 켜던 그 증상으로 되돌아간다. 새 종류가 실제로
// 에이전트 작업이면 위 목록에 이름을 더하는 것이 답이지, 모르는 것을 전부 세는 것이 아니다.
function classifyBackgroundTask(
  entry: BackgroundTaskEntry,
  selfAgentId: string | undefined,
  settledAgentIds: ReadonlySet<string>,
): "live" | "not-agent-work" | "unreadable" {
  if (typeof entry.id === "string" && (entry.id === selfAgentId || settledAgentIds.has(entry.id))) return "not-agent-work";
  if (typeof entry.type !== "string") return "unreadable";
  if (AGENT_BACKGROUND_TASK_TYPES.has(entry.type)) return "live";
  return NON_AGENT_BACKGROUND_TASK_TYPES.has(entry.type) ? "not-agent-work" : "unreadable";
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
