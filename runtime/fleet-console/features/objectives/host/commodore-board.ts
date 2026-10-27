import type { CommodoreBoardWakeCode, CommodoreBoardWatch, CommodoreTurnBindings, CommodoreWakeSink } from "../shared/commodore-board.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import { createdByCommodore, groupIdle, holdTargetOf, inboxReasons, livePersonHold, objectiveOperator, objectiveStatus, stalledObjectives, stallEpisode, type BoardObserver, type InboxReason, type ObjectiveOperator, type ObjectiveStatus } from "../shared/board-state.js";
import type { Objective, ObjectiveEvent } from "../shared/types.js";

export const STALL_CHECK_MS = 5 * 60_000;
/** 그룹 대화의 대기 중을 보는 주기. */
export const SETTLE_CHECK_MS = 2_000;
/** 대기 중이 이만큼 이어져야 들어선 것으로 본다 — 구성원 보고와 지휘관 턴 시작 사이의 짧은 틈은 대기 중이 아니다. */
export const SETTLE_MS = 10_000;
type WakeCode = CommodoreBoardWakeCode;
/** 사령관 자신의 보드 쓰기가 끝난 뒤에도 그 목표의 상태 변화를 제 것으로 보는 시간 — 기동처럼 쓰기 뒤에 이어지는 사건까지. */
const SELF_WRITE_GRACE_MS = 5_000;
const STATUS_WORDS: Record<ObjectiveStatus | "new", string> = {
  new: "new", pending: "not started", planning: "planning", planned: "lineup ready", running: "in progress",
  "missions-done": "missions done, awaiting hand-off", review: "awaiting review", done: "done", removed: "removed",
};
/** 감독자가 아는 목표 한 자리 — 상태와 운영 주체. 운영 주체가 사람에서 사령관으로 바뀌면 「맡겨짐」으로 깨운다. */
interface TrackedStatus {
  readonly status: ObjectiveStatus;
  readonly operator: ObjectiveOperator;
}

/** 사람이 운영하는 목표의 대기 키 머리 — 깨우지 않고 기록에만 남긴다. */
const HUMAN_KEY = "human";
/** 사령관이 사람에게 넘긴 항목의 대기 키 머리 — 깨우지 않는다. 돌려받으면 머리 없는 새 항목이 되어 그때 깨운다. */
const PERSON_KEY = "person";
/** 넘김이 끝난 사건(사람이 답함·돌려줌) — 대기가 아니라 한 번 깨우는 항목이다. 상세는 목표 제목과 대상. */
const SETTLED_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>(["answered", "returned"]);

/** 보드 요약이 대기 이유를 부르는 말. */
const REASON_WORDS: Record<InboxReason, string> = {
  decision: "decision request", criteria: "criteria proposal", review: "awaiting review", followup: "open follow-up candidates",
  "followup-failed": "failed follow-up creation", pending: "not commenced", planned: "lineup ready to commence", stalled: "stalled", "member-failed": "failed member turn",
};
/** 보드 요약에 싣는 목표 수의 상한 — 넘으면 수만 적는다. */
const BRIEF_OBJECTIVES = 8;

/** 보드 대기 상태의 코드 — 수는 턴 직전의 보드에서 다시 센다. */
const BOARD_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>(["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"]);

interface Runner {
  readonly commodoreId: string;
  seen: Set<string>;
  stalledReported: Set<string>;
  notifiedStall: Map<string, string>;
  emptyReported: boolean;
  statuses: Map<string, TrackedStatus>;
  selfWrites: Map<string, number>;
  /** 깨우지 않고 모은 단계 이동 — 다음 턴의 보드 요약에 실리고 비워진다. */
  moves: Map<string, string[]>;
  /** 그룹 대화가 대기 중이 된 시각. */
  idleSince: Map<string, number>;
  /** 대기 중으로 깨운(또는 할 일이 없어 넘긴) 보드 서명 — 같은 보드로는 다시 깨우지 않는다. */
  settledAt: Map<string, string>;
}
export interface CommodoreBoardWatchDeps {
  readonly objectives: (commodoreId: string) => readonly Objective[];
  readonly subscribeObjectives: (listener: (event: ObjectiveEvent) => void) => () => void;
  readonly observe?: BoardObserver;
  readonly notifyCommanderRest?: (objectiveId: string) => Promise<boolean>;
  /** 재시작 뒤 잇지 못한 목표 — 꺼낸 것은 다시 오지 않는다. */
  readonly resumeFailures?: {
    readonly take: (commodoreId: string) => readonly { readonly objectiveId: string; readonly title: string; readonly error: string }[];
    readonly subscribe: (listener: (commodoreId: string) => void) => () => void;
  };
  readonly now?: () => number;
}

/** 보드와 같은 대기·운영·정체 규칙. 사령관 feature에는 정규화한 깨움만 보낸다. */
export function createCommodoreBoardWatch(deps: CommodoreBoardWatchDeps, commodoreId: string, sink: CommodoreWakeSink): CommodoreBoardWatch {
  const now = deps.now ?? Date.now;
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const runner: Runner = { commodoreId, seen: waitingKeys(deps.objectives(commodoreId), deps.observe), statuses: statusMap(deps.objectives(commodoreId)), stalledReported: new Set(), notifiedStall: new Map(), emptyReported: false, selfWrites: new Map(), moves: new Map(), idleSince: new Map(), settledAt: new Map() };
  const wake = (_runner: Runner, code: WakeCode, input?: Parameters<CommodoreWakeSink["wake"]>[1]) => sink.wake(code, input);
  const forgetStatus = (_runner: Runner, objectiveId: string) => sink.forget(objectiveId);
  const publish = (runner: Runner) => sink.stalledChanged([...runner.stalledReported]);
  /** 사람이 운영하는 목표에 나서 깨우지 않은 사건 — 다음 턴의 범위 줄에 한 번 실리고 비워진다. */
  const held = new WeakMap<Runner, Map<string, Set<string>>>();
  const hold = (runner: Runner, objectiveId: string, code: string) => {
    let byObjective = held.get(runner);
    if (!byObjective) held.set(runner, byObjective = new Map());
    let codes = byObjective.get(objectiveId);
    if (!codes) byObjective.set(objectiveId, codes = new Set());
    codes.add(code);
  };
  /** 이번 턴의 보드 범위(기록 전용) — 보드 대기 코드는 지금 그 이유를 가진 운영 목표, 상태·정체는 모인 목표, 그리고 held. */
  const scopeOf = (runner: Runner, pending: ReadonlyMap<string, readonly string[]>) => {
    const objectives = deps.objectives(runner.commodoreId);
    const operators = operatorsOf(objectives);
    const woke = new Map<string, Set<string>>();
    const add = (id: string, code: string) => { let codes = woke.get(id); if (!codes) woke.set(id, codes = new Set()); codes.add(code); };
    for (const [code, ids] of pending) {
      if (BOARD_CODES.has(code as WakeCode)) { for (const objective of objectives) if (operators.get(objective.id) === "commodore" && inboxReasons(objective).some((reason) => reason === code && !heldForPerson(objective, reason))) add(objective.id, code); }
      else for (const id of ids) add(id, code);
    }
    const quiet = held.get(runner);
    held.delete(runner);
    if (!woke.size && !quiet?.size) return null;
    // 보드에서 사라진 목표는 사령관이 운영하던 것만 상태 변화로 실린다.
    return {
      woke: [...woke].map(([id, codes]) => ({ id, operator: operators.get(id) ?? "commodore", codes: [...codes] })),
      held: [...(quiet ?? [])].map(([id, codes]) => ({ id, operator: "human" as const, codes: [...codes] })),
    };
  };

  /** 지난 상태에서 열려 있던 운영 목표 중 지금 닫힌 것이 있고, 그것이 모두 사령관의 (아직 유예 안의) 쓰기 대상인가. */
  const closedBySelf = (runner: Runner, objectives: readonly Objective[]): boolean => {
    const at = now();
    const open = new Set(objectives.filter((objective) => !objective.done && !objective.removed).map((objective) => objective.id));
    const closed = [...runner.statuses].filter(([id, tracked]) => tracked.operator === "commodore" && tracked.status !== "done" && tracked.status !== "removed" && !open.has(id)).map(([id]) => id);
    return closed.length > 0 && closed.every((id) => (runner.selfWrites.get(id) ?? 0) >= at);
  };

  // 보드 사건 — 결정 요청은 그룹이 일하는 중에도 바로 깨운다. 다른 대기 상태는 그 목표에 그룹 대화가 있으면 혼자 깨우지 않고,
  // 그룹이 대기 중이 될 때 그 목표의 보드 요약으로 실린다. 그룹이 없는 사건(후속 생성 실패, 끝난 목표의 후속 후보)과 사람이 넘겨받은
  // 항목의 마무리도 바로 깨운다. 착수 전 목표(pending)는 깨우지 않는다. 관측이 없는 호스트는 대기 항목마다 바로 깨운다.
  // 줄어든 항목은 조용히 잊어 같은 상태가 돌아오면 다시 본다. 사람이 운영하는 목표의 사건은 깨우지 않고 다음 턴의 범위 줄(held)에만 남는다.
  /** 대기 상태를 다시 보고 아직 듣지 못한 항목으로 깨운다. */
  const waitingChanged = (runner: Runner, objectives: readonly Objective[]) => {
    const current = waitingKeys(objectives, deps.observe);
    const fresh = [...current].filter((key) => !runner.seen.has(key));
    runner.seen = current;
    const freshCodes = new Set<WakeCode>();
    const settled: { code: WakeCode; id: string; detail: string }[] = [];
    for (const key of fresh) {
      const [head, ...rest] = key.split(":");
      if (head === HUMAN_KEY) hold(runner, rest[1]!, rest[0]!);
      else if (head === PERSON_KEY) continue;
      else if (SETTLED_CODES.has(head as WakeCode)) settled.push({ code: head as WakeCode, id: rest[0]!, detail: `"${objectives.find((objective) => objective.id === rest[0])?.title ?? rest[0]}" ${rest[1]}` });
      else if (immediate(head as WakeCode, objectives.find((objective) => objective.id === rest[0]))) {
        freshCodes.add(head as WakeCode);
        if (head === "decision") heard(runner, objectives, rest[0]!);
      }
    }
    if (freshCodes.size) {
      const digest = new Map(inboxDigest(objectives, deps.observe));
      for (const code of freshCodes) wake(runner, code, { count: digest.get(code) ?? 1 });
    }
    // 사람이 넘겨받은 항목을 끝냈다 — 그 목표와 대상을 깨움 문장과 범위 줄에 남긴다.
    for (const entry of settled) { wake(runner, entry.code, { bump: true, detail: entry.detail, objectiveId: entry.id }); heard(runner, objectives, entry.id); }
  };
  /** 그룹 대화가 대기 중이 되기를 기다리지 않고 바로 깨울 대기 항목인가. */
  const immediate = (code: WakeCode, objective: Objective | undefined): boolean => {
    const observe = deps.observe;
    if (!observe) return true;
    if (code === "decision" || code === "followup-failed") return true;
    if (code === "pending") return false;
    return !objective || !!objective.done || !observe(objective.id);
  };
  /** 이 목표로 이미 깨웠다 — 지금 보드 서명을 대기 중 깨움이 들은 것으로 둔다(같은 보드로 두 번 깨우지 않는다). */
  const heard = (runner: Runner, objectives: readonly Objective[], objectiveId: string) => {
    const objective = objectives.find((candidate) => candidate.id === objectiveId);
    if (objective) runner.settledAt.set(objectiveId, boardSignature(objective));
  };
  /** 보드를 다시 본다 — 대기 상태, 빈 보드, 상태 변화. */
  const boardChanged = (runner: Runner) => {
    const objectives = deps.objectives(runner.commodoreId);
    waitingChanged(runner, objectives);
    const empty = !hasOpenOperated(objectives);
    // 사령관 자신의 완료·정리로 보드가 비었으면 깨우지 않는다 — 방금 닫힌 운영 목표가 모두 그의 쓰기 대상이면 그것은 제가 한 일이다.
    if (empty && !runner.emptyReported && !closedBySelf(runner, objectives)) wake(runner, "empty");
    runner.emptyReported = empty;
    // 상태 변화 — 사령관이 운영하는 목표가 한 단계 옮겨 갈 때마다(새 목표·지워짐·사람이 맡김 포함). 사령관 자신의 쓰기와 그 쓰기로
    // 생긴 목표는 뺀다. 사람이 맡긴 것만 깨우고, 나머지는 다음 턴의 보드 요약에 싣는다(관측이 없으면 모두 깨운다).
    for (const change of statusChanges(runner, objectives)) {
      if (change.handed || !deps.observe) { wake(runner, "status", { bump: true, detail: change.text, objectiveId: change.id }); if (change.handed) heard(runner, objectives, change.id); }
      else runner.moves.set(change.id, [...(runner.moves.get(change.id) ?? []), change.move]);
    }
  };
  cleanups.push(deps.subscribeObjectives((event) => {
    if (!disposed && sink.automatic() && event.commodoreId === commodoreId) boardChanged(runner);
  }));

  // 그룹 대화의 대기 중 — 사령관이 운영하는 열린 목표에서 지휘관과 띄운 구성원이 모두 멈춰 `SETTLE_MS` 이어지면 들어선 것이다.
  // 들어설 때 한 번 깨운다: 같은 보드 서명으로 이미 깨웠으면 다시 깨우지 않고(그 뒤는 정체 판정이 맡는다), 남은 일이 모두 사람
  // 몫이면 깨우지 않는다. 대기 항목(기준·개시·결정·검토·후속·구성원 실패)과 단계 이동은 이 깨움의 보드 요약으로 실린다.
  // 감시가 막 섰을 때(Console 재시작·순찰 시작) 이미 대기 중인 그룹은 바로 들어선 것으로 본다 — 그 턴과 함께 깨운다.
  const settle = (runner: Runner, seeded: boolean) => {
    if (disposed || !sink.automatic() || !deps.observe) return;
    const observe = deps.observe;
    const objectives = deps.objectives(runner.commodoreId);
    const operators = operatorsOf(objectives);
    const at = now();
    const open = new Set<string>();
    for (const objective of objectives) {
      if (objective.done || objective.removed || operators.get(objective.id) !== "commodore") continue;
      open.add(objective.id);
      if (!groupIdle(objective, observe)) { runner.idleSince.delete(objective.id); continue; }
      const since = runner.idleSince.get(objective.id) ?? (seeded ? at - SETTLE_MS : at);
      runner.idleSince.set(objective.id, since);
      if (at - since < SETTLE_MS) continue;
      const signature = boardSignature(objective);
      if (runner.settledAt.get(objective.id) === signature) continue;
      runner.settledAt.set(objective.id, signature);
      // 사령관 자신이 막 쓴 보드는 제가 한 일이다 — 그 서명으로는 깨우지 않는다.
      if ((runner.selfWrites.get(objective.id) ?? 0) >= at) continue;
      if (awaitsCommodore(objective, observe)) wake(runner, "settled", { bump: true, detail: `"${objective.title}"`, objectiveId: objective.id });
    }
    for (const map of [runner.idleSince, runner.settledAt]) for (const id of [...map.keys()]) if (!open.has(id)) map.delete(id);
  };
  const settleTimer = setInterval(() => settle(runner, false), SETTLE_CHECK_MS);
  settleTimer.unref?.();
  cleanups.push(() => clearInterval(settleTimer));
  queueMicrotask(() => settle(runner, true));

  /** 이번 턴의 보드 요약 — 깨운 목표의 지금 자리와 지난 턴 뒤 이동, 그리고 깨우지 않은 목표의 이동. 이동 기록은 여기서 비운다. */
  const briefOf = (runner: Runner, ids: readonly string[]): string | null => {
    const objectives = deps.objectives(runner.commodoreId);
    const byId = new Map(objectives.map((objective) => [objective.id, objective]));
    const operators = operatorsOf(objectives);
    const at = now();
    const woke = [...new Set(ids)].filter((id) => byId.has(id) && operators.get(id) === "commodore");
    const lines: string[] = [];
    for (const id of woke.slice(0, BRIEF_OBJECTIVES)) {
      const objective = byId.get(id)!;
      const done = objective.missions.filter((mission) => mission.done).length;
      const reasons = inboxReasons(objective, deps.observe ? { observe: deps.observe, now: at } : {});
      const mine = reasons.filter((reason) => !heldForPerson(objective, reason)).map((reason) => REASON_WORDS[reason]);
      const theirs = reasons.filter((reason) => heldForPerson(objective, reason)).map((reason) => REASON_WORDS[reason]);
      lines.push(`- ${objective.id} "${objective.title}"`);
      lines.push(`  status: ${STATUS_WORDS[objectiveStatus(objective)]}${objective.missions.length ? ` · missions ${done}/${objective.missions.length} done` : " · no missions"}`);
      if (mine.length) lines.push(`  waits on you: ${mine.join(", ")}`);
      if (theirs.length) lines.push(`  waits on the person: ${theirs.join(", ")}`);
      const group = groupLine(objective, deps.observe, runner.idleSince.get(id), at);
      if (group) lines.push(`  group: ${group}`);
      const moves = runner.moves.get(id);
      if (moves?.length) lines.push(`  since your last turn: ${moves.join("; ")}`);
      runner.moves.delete(id);
    }
    if (woke.length > BRIEF_OBJECTIVES) { lines.push(`- and ${woke.length - BRIEF_OBJECTIVES} more (read the board)`); for (const id of woke.slice(BRIEF_OBJECTIVES)) runner.moves.delete(id); }
    const others = [...runner.moves].filter(([, moves]) => moves.length);
    runner.moves.clear();
    const otherLines = others.slice(0, BRIEF_OBJECTIVES).map(([id, moves]) => `- ${byId.has(id) ? `"${byId.get(id)!.title}"` : id}: ${moves.join("; ")}`);
    if (others.length > BRIEF_OBJECTIVES) otherLines.push(`- and ${others.length - BRIEF_OBJECTIVES} more`);
    if (!lines.length && !otherLines.length) return null;
    return [...(lines.length ? ["Board at wake:", ...lines] : []), ...(otherLines.length ? ["Other objectives moved since your last turn:", ...otherLines] : [])].join("\n");
  };

  /** 보드 도구를 감싸 사령관이 쓰는 목표를 표시한다 — 쓰는 동안과 끝난 뒤 잠깐, 그 목표의 상태 변화는 사령관 자신의 것이다. */
  const selfAttributed = (runner: Runner, tool: ConsoleMcpTool, turn: CommodoreTurnBindings): ConsoleMcpTool => ({
    ...tool,
    execute: async (args, context) => {
      // 종료 알림은 보드를 변경하는 마지막 기회가 아니다. 이미 실행 중인 쓰기를 되돌리지는 않는다.
      if (disposed || turn.stopping()) return { content: [{ type: "text", text: JSON.stringify({ error: "commodore_stopping" }) }], isError: true };
      const targets = writeTargets(args);
      for (const id of targets) runner.selfWrites.set(id, Number.POSITIVE_INFINITY);
      let busy: string | null = null;
      try {
        const result = await tool.execute(args, context);
        // 지휘관이 일하는 중이라 개시가 거절됐다 — 그 목표의 개시 대기는 들은 항목에서 내리고 대기 중 깨움도 다시 세워, 그 일이 끝나
        // 그룹이 대기 중이 되면 보드가 그대로여도 다시 깨운다. 점검 주기보다 짧은 턴이어도 이 거절이 일하던 때를 증언한다.
        const call = (args ?? {}) as { action?: unknown; objectiveId?: unknown };
        if (call.action === "commence" && typeof call.objectiveId === "string" && (result as { structuredContent?: { error?: unknown } }).structuredContent?.error === "objective_busy") busy = call.objectiveId;
        return result;
      } finally {
        const until = now() + SELF_WRITE_GRACE_MS;
        // 이 목표에 쓴 손은 그 목표의 지금 상태를 보고 행동했다 — 턴 도중 쌓인 그 목표의 상태·정체 사유는 처리된 것이라 다음 턴을 열지 않는다.
        for (const id of targets) { runner.selfWrites.set(id, until); forgetStatus(runner, id); }
        if (busy) { runner.seen.delete(`planned:${busy}`); runner.settledAt.delete(busy); runner.idleSince.delete(busy); runner.selfWrites.delete(busy); }
      }
    },
  });

  const statusChanges = (runner: Runner, objectives: readonly Objective[]): { readonly id: string; readonly text: string; readonly move: string; readonly handed?: true }[] => {
    const at = now();
    for (const [id, until] of runner.selfWrites) if (until < at) runner.selfWrites.delete(id);
    const tracked = statusMap(objectives);
    const byId = new Map(objectives.map((objective) => [objective.id, objective]));
    const changes: { id: string; text: string; move: string; handed?: true }[] = [];
    for (const objective of objectives) {
      const next = tracked.get(objective.id)!;
      const previous = runner.statuses.get(objective.id);
      if (previous?.status === next.status && previous.operator === next.operator) continue;
      // 검토 대기로 옮긴 목표도 지휘관이 그 턴을 마칠 때까지 미룬다 — 옛 상태를 남겨 두어 다시 볼 때 이 전환으로 깨운다.
      if (next.status === "review" && previous?.operator === next.operator && commanderWorking(deps.observe, objective.id)) continue;
      runner.statuses.set(objective.id, next);
      // 사람이 맡김 — 사령관은 운영값을 바꿀 수 없으므로 이 전환은 늘 사람의 것이다. 사령관의 쓰기 유예 안이어도 한 번 깨운다.
      if (previous?.operator === "human" && next.operator === "commodore") { changes.push({ id: objective.id, text: `"${objective.title}" handed to you by the person (${STATUS_WORDS[next.status]})`, move: `handed to you (${STATUS_WORDS[next.status]})`, handed: true }); continue; }
      // 사람이 돌려받음 — 깨우지 않고, 모으는 동안 쌓인 이 목표의 상태·정체 사유(방금 맡김 포함)도 걷는다.
      if (previous?.operator === "commodore" && next.operator === "human") { forgetStatus(runner, objective.id); runner.moves.delete(objective.id); continue; }
      if (runner.selfWrites.has(objective.id)) continue;
      // 임무가 끝나 인계를 기다리는 단계는 지휘관의 몫이다(회고를 모아 인계한다) — 사령관은 검토 대기나 정체로 깨운다.
      if (next.status === "missions-done") continue;
      // 사람이 운영하는 목표는 깨우지 않고 기록에만 남긴다.
      if (next.operator === "human") { hold(runner, objective.id, "status"); continue; }
      if (previous === undefined && createdByCommodore(objective, (id) => byId.get(id))) continue;
      const move = `${STATUS_WORDS[previous?.status ?? "new"]} → ${STATUS_WORDS[next.status]}`;
      changes.push({ id: objective.id, text: `"${objective.title}" ${move}`, move });
    }
    // 보드에서 영영 사라진 목표(영구 삭제)도 지워짐이다.
    for (const [id, previous] of [...runner.statuses]) {
      if (byId.has(id)) continue;
      runner.statuses.delete(id);
      if (previous.status === "removed" || runner.selfWrites.has(id)) continue;
      if (previous.operator === "human") hold(runner, id, "status");
      else { const move = `${STATUS_WORDS[previous.status]} → ${STATUS_WORDS.removed}`; changes.push({ id, text: `${id} ${move}`, move }); }
    }
    return changes;
  };


  // 재시작 뒤 잇지 못한 목표 — 재시작만으로는 깨우지 않고, 이어 가지 못한 목표가 있을 때만 깨운다. 감시를 세운 직후의 것도 한 번 본다.
  if (deps.resumeFailures) {
    const failures = deps.resumeFailures;
    const report = () => {
      if (disposed) return;
      for (const failure of failures.take(runner.commodoreId)) wake(runner, "resume-failed", { bump: true, detail: `"${failure.title}" (${failure.error})`, objectiveId: failure.objectiveId });
    };
    cleanups.push(failures.subscribe((commodoreId) => { if (commodoreId === runner.commodoreId) report(); }));
    const first = setTimeout(report, 0);
    first.unref?.();
    cleanups.push(() => clearTimeout(first));
  }

  // 정체 — 보드와 같은 판정(`stalledObjectives`): 임무가 남았는데 구성원이 일하는 동안 지휘관이 오래 쉬거나, 보드가 오래 그대로인데
  // 모두 쉰다. 새로 정체된 목표만 한 번 깨우고, 움직이거나 보드에서 사라지면 표시를 거둔다.
  const stallTimer = setInterval(() => {
    if (disposed || !sink.automatic() || !deps.observe) return;
    {
      const objectives = deps.objectives(runner.commodoreId);
      const operators = operatorsOf(objectives);
      const stalled = new Set(stalledObjectives(objectives, deps.observe, now()));
      let changed = false;
      for (const id of [...runner.stalledReported]) if (!stalled.has(id)) { runner.stalledReported.delete(id); changed = true; }
      // 끝난 에피소드의 통지 기록은 거둔다 — 보드가 앞으로 가거나 일하는 명단이 바뀌거나 관문을 못 넘으면 다음 정체는 새 에피소드다.
      // 통지 때문에 생긴 지휘관 턴은 서명을 바꾸지 않으므로 기록이 남아 되울림을 막는다.
      for (const [id, episode] of [...runner.notifiedStall]) {
        const current = objectives.find((objective) => objective.id === id);
        if (!current || stallEpisode(current, deps.observe) !== episode) runner.notifiedStall.delete(id);
      }
      for (const id of stalled) {
        if (runner.stalledReported.has(id)) continue;
        runner.stalledReported.add(id); changed = true;
        // 정체 표시는 사람의 줄에도 서야 하므로 모두 적고, 깨우는 것은 사령관이 운영하는 목표만이다.
        if (operators.get(id) === "human") { hold(runner, id, "stalled"); continue; }
        const current = objectives.find((objective) => objective.id === id);
        const episode = current ? stallEpisode(current, deps.observe) : null;
        if (episode !== null && runner.notifiedStall.get(id) === episode) continue;
        const title = current?.title ?? id;
        wake(runner, "stalled", { bump: true, detail: title, objectiveId: id });
        void deps.notifyCommanderRest?.(id).catch(() => false);
        if (episode !== null) runner.notifiedStall.set(id, episode);
      }
      if (changed) publish(runner);
    }
  }, STALL_CHECK_MS);
  stallTimer.unref?.();
  cleanups.push(() => clearInterval(stallTimer));

  return {
    recount: () => new Map(inboxDigest(deps.objectives(commodoreId), deps.observe)),
    scope: (pending) => scopeOf(runner, pending),
    emptyOperated: () => { const empty = !hasOpenOperated(deps.objectives(commodoreId)); runner.emptyReported = empty; return empty; },
    brief: (ids) => briefOf(runner, ids),
    attribute: (tool, turn) => selfAttributed(runner, tool, turn),
    dispose: () => { disposed = true; for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

function statusMap(objectives: readonly Objective[]): Map<string, TrackedStatus> {
  const operators = operatorsOf(objectives);
  return new Map(objectives.map((objective) => [objective.id, { status: objectiveStatus(objective), operator: operators.get(objective.id)! }]));
}

/** 목표마다 운영 주체 — 깨움·집계·기록이 같은 판정(`objectiveOperator`)을 쓴다. */
function operatorsOf(objectives: readonly Objective[]): Map<string, ObjectiveOperator> {
  const byId = new Map(objectives.map((objective) => [objective.id, objective]));
  return new Map(objectives.map((objective) => [objective.id, objectiveOperator(objective, (id) => byId.get(id))]));
}

/** 사령관이 운영하는 열린 목표가 하나라도 있다 — 없으면 「빈 보드」로 한 번 깨운다. */
function hasOpenOperated(objectives: readonly Objective[]): boolean {
  const operators = operatorsOf(objectives);
  return objectives.some((objective) => operators.get(objective.id) === "commodore" && !objective.done && !objective.removed);
}

/** 보드 도구 입력이 가리키는 목표 — 읽기는 상태를 바꾸지 않으니 함께 표시돼도 해가 없다. */
function writeTargets(args: unknown): readonly string[] {
  if (!args || typeof args !== "object") return [];
  const input = args as { objectiveId?: unknown; objectiveIds?: unknown; into?: unknown; from?: unknown };
  const ids = [input.objectiveId, ...(Array.isArray(input.objectiveIds) ? input.objectiveIds : []), input.into, ...(Array.isArray(input.from) ? input.from : [])];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * 감독자가 듣는 대기 이유 — inbox 보기와 같은 관측으로, 지휘관 턴이 도는 동안의 목표는 개시 대기가 아니다. 정체는 정체 타이머가
 * 따로 깨우므로 뺀다.
 */
function waitingReasons(objective: Objective, observe: BoardObserver | undefined): readonly InboxReason[] {
  // 검토 대기도 지휘관이 그 턴을 마친 뒤에 — 인계는 턴 도중에 기록되고, 그 턴이 끝나기 전의 완료는 objective_busy 다.
  // 인계와 함께 선 후속 후보도 같은 때에 — 검토와 한 번에 깨워 모인 후보 전체를 판단하게 한다.
  const atReview = (reason: InboxReason) => reason === "review" || (reason === "followup" && !objective.done);
  return inboxReasons(objective, observe ? { observe } : {}).filter((reason) => reason !== "stalled" && !(atReview(reason) && commanderWorking(observe, objective.id)));
}

/** 지휘관이 일하는 중인가(턴 또는 백그라운드 작업) — 관측이 없으면 아니다. */
function commanderWorking(observe: BoardObserver | undefined, objectiveId: string): boolean {
  const observation = observe?.(objectiveId);
  return !!observation && observation.lifecycle === "live" && (observation.activity === "running" || observation.activity === "background");
}

/**
 * 보드의 대기 상태 항목 — `code:objectiveId`, 결정 요청은 개정까지(같은 목표의 새 요청도 새 항목). 이유는 inbox 보기와 같다.
 * 사람이 운영하는 목표의 항목은 `human:` 머리를 단다 — 깨우지 않고, 사람이 맡기면 머리 없는 새 항목이 되어 그때 깨운다.
 */
function waitingKeys(objectives: readonly Objective[], observe?: BoardObserver): Set<string> {
  const operators = operatorsOf(objectives);
  const keys = new Set<string>();
  for (const objective of objectives) {
    const human = operators.get(objective.id) === "human";
    for (const reason of waitingReasons(objective, observe)) {
      const head = human ? `${HUMAN_KEY}:` : heldForPerson(objective, reason) ? `${PERSON_KEY}:` : "";
      keys.add(head + (reason === "decision" ? `${reason}:${objective.id}:${objective.decisionRequestRevision}` : `${reason}:${objective.id}`));
    }
    // 넘김이 끝난 사건 — 끝난 시각까지 키에 실어 같은 대상의 다음 넘김이 끝나도 새 항목이 된다. 사람이 운영하는 목표는 깨우지 않는다.
    if (!human) for (const hold of objective.personHolds ?? []) if (hold.settled) keys.add(`${hold.settled.outcome}:${objective.id}:${hold.target}:${hold.settled.at}`);
  }
  return keys;
}

/** 사령관이 사람에게 넘겨 지금 사람이 답할 차례인 대기 이유. */
function heldForPerson(objective: Objective, reason: InboxReason): boolean {
  const target = holdTargetOf(reason);
  return !!target && !!livePersonHold(objective, target);
}

/** 사령관이 운영하는 목표에 남은 대기 상태의 수 — 지금 그 이유를 가진 목표 수(절대값). 없으면 빈 목록이다. */
function inboxDigest(objectives: readonly Objective[], observe?: BoardObserver): readonly [WakeCode, number][] {
  // 보드가 아는 이유 코드는 깨움 코드와 이름이 같다 — 보드가 새 이유를 더하면 여기 순서에 넣는다.
  const operators = operatorsOf(objectives);
  const counts = new Map<string, number>();
  for (const objective of objectives) if (operators.get(objective.id) === "commodore") for (const reason of waitingReasons(objective, observe)) if (!heldForPerson(objective, reason)) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return (["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"] as const).flatMap((code) => (counts.get(code) ? [[code, counts.get(code)!] as [WakeCode, number]] : []));
}

/**
 * 대기 중인 그룹에 사령관이 할 일이 있나 — 사령관 몫의 대기 항목이 있거나, 사람에게 넘긴 항목 없이 일이 멈췄다(구상 중·임무가 남음·
 * 인계 대기). 사람에게 넘긴 항목을 기다리며 멈춘 그룹은 사람의 몫이다.
 */
function awaitsCommodore(objective: Objective, observe: BoardObserver): boolean {
  if (waitingReasons(objective, observe).some((reason) => !heldForPerson(objective, reason))) return true;
  if ((objective.personHolds ?? []).some((hold) => livePersonHold(objective, hold.target))) return false;
  return objective.planning || (objective.commenced && (objective.awaitingHandoff || objective.missions.some((mission) => !mission.done)));
}

/** 보드 요약의 그룹 줄 — 대기 중이면 그 분, 지휘관과 띄운 구성원의 활동. 지휘관을 관측할 수 없으면 null. */
function groupLine(objective: Objective, observe: BoardObserver | undefined, idleSince: number | undefined, at: number): string | null {
  const commander = observe?.(objective.id);
  if (!observe || !commander) return null;
  const word = (observation: ReturnType<BoardObserver>) => !observation ? "unknown" : observation.lifecycle === "live" ? observation.activity : observation.lifecycle;
  const members = objective.members.filter((member) => member.sessionName !== null).map((member) => `${member.role} ${word(observe(member.id))}`);
  const idle = groupIdle(objective, observe) && idleSince !== undefined ? `idle ${Math.floor((at - idleSince) / 60_000)} min · ` : "";
  return `${idle}commander ${word(commander)}${members.length ? ` · members: ${members.join(", ")}` : " · no members"}`;
}

/** 대기 중 깨움의 보드 서명 — 보드가 앞으로 가면 바뀐다. */
const boardSignature = (objective: Objective): string => {
  // 구성원 실패 기록은 보드 시계를 옮기지 않는다 — 확인하지 않은 실패와 그 연속 횟수를 서명에 넣어 새 실패가 다시 깨우게 한다.
  const failures = objective.members.flatMap((member) => (member.failure && !member.failure.acknowledged ? [`${member.id}:${member.failure.consecutiveFailures}`] : []));
  return `${objective.boardUpdatedAt ?? objective.createdAt}${failures.length ? `|${failures.join(",")}` : ""}`;
};
