import {
  CONSOLE_OBJECTIVE_PEEK_MAX_BYTES,
  CONSOLE_OBJECTIVE_PEEK_MAX_CRITERIA,
  CONSOLE_OBJECTIVE_PEEK_MAX_MEMBERS,
  CONSOLE_OBJECTIVE_PEEK_MAX_MISSIONS,
  CONSOLE_OBJECTIVE_PEEK_MAX_RESULTS,
  isConsoleObjectivePeek,
  type ConsoleObjectivePeek,
  type ConsoleObjectivePeekMember,
  type ConsoleObjectivePeekPhase,
  type ConsoleObjectivePeekResult,
  type ConsoleRosterRun,
} from "../../../protocol/desktop/console-section.js";
import {
  lineupOrder,
  missionTitle,
  type Objective,
} from "../../objectives/shared/types.js";

/** 구성원 한 사람의 실행 낱말 — 조립부가 세션 관측에서 읽어 준다. 명부의 낱말과 같다. */
export type ObjectivePeekRunOf = (memberId: string) => ConsoleRosterRun;

const CONTROL_LINE = /[\u0000-\u001f\u007f]/g;
const CONTROL_PROSE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** 한 줄 — 제어 문자를 공백으로, 길이를 계약에 맞춘다. */
function line(value: string, max: number): string {
  return value.replace(CONTROL_LINE, " ").trim().slice(0, max);
}

/** 여러 문단 글 — 탭은 공백으로, `\r\n`을 `\n`으로, 남은 `\r`과 제어 문자는 지운다. */
function prose(value: string, max: number): string {
  return value.replace(/\t/g, " ").replace(/\r\n?/g, "\n").replace(CONTROL_PROSE, "").slice(0, max);
}

/** 절대 `https:` URL만 — 원격이 준 `javascript:`·상대 URL은 결과에서 뺀다. */
function peekableUrl(value: string): string | null {
  if (value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function phaseOf(objective: Objective): ConsoleObjectivePeekPhase {
  if (objective.done !== null) return "done";
  if (objective.awaitingReview || objective.awaitingHandoff) return "review";
  if (objective.planning) return "planning";
  return "active";
}

/** 자르는 동안만 바뀌는 일꾼 모양 — 밖에는 읽기 전용 계약으로 나간다. */
interface MutableMission {
  readonly title: string;
  readonly text: string;
  readonly done: boolean;
  readonly assignee: string | null;
  readonly premises: readonly number[];
  readonly records: string[];
}
interface MutableSnapshot {
  readonly v: 1;
  readonly id: string;
  readonly title: string;
  note: string | null;
  readonly phase: ConsoleObjectivePeekPhase;
  readonly criteria: readonly { readonly text: string; readonly met: boolean }[];
  readonly missions: readonly MutableMission[];
  readonly members: readonly ConsoleObjectivePeekMember[];
  readonly results: ConsoleObjectivePeekResult[];
  truncated?: true;
}

/**
 * 진행 중 목표 하나의 표시 전용 스냅샷. 대화·세션·경로·결정·자문·후속·행동·토큰·첨부·공유 폴더는
 * 읽지 않는다 — 받는 구조에 그 칸이 없다. 64 KiB를 넘으면 긴 글(브리핑·임무 기록)부터 자르고,
 * 그래도 넘으면 결과물을 뒤에서 뺀다. 무엇을 잘랐든 `truncated: true`를 싣는다.
 * 계약 검증기를 스스로 통과하지 못하면 null — 경로는 구분 없이 404로 답한다.
 */
export function buildObjectivePeek(objective: Objective, memberRunOf: ObjectivePeekRunOf): ConsoleObjectivePeek | null {
  const roles = new Map<string, string>();
  const members: ConsoleObjectivePeekMember[] = [];
  for (const member of objective.members.slice(0, CONSOLE_OBJECTIVE_PEEK_MAX_MEMBERS)) {
    const role = line(member.role, 40);
    if (!role) continue;
    roles.set(member.id, role);
    const brief = prose(member.brief ?? "", 300);
    const model = line(member.model ?? member.launch?.model ?? "", 120);
    members.push({
      role, brief: brief.length > 0 ? brief : null, model: model.length > 0 ? model : null, run: memberRunOf(member.id),
    });
  }

  // 편성 순 — 화면·번호와 같은 순서. StoredMission 모양으로 가볍게 옮겨 정렬만 빌린다.
  const adapted = objective.missions.map((mission) => ({
    id: mission.id, text: "",
    prerequisites: mission.prerequisites.map((id) => ({ id })),
    ...(mission.done ? { done: true as const } : {}),
    ...(mission.unplaced ? { unplaced: true as const } : {}),
  }));
  const order = new Map(lineupOrder(adapted).map((mission, index) => [mission.id, index]));
  const served = [...objective.missions]
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
    .slice(0, CONSOLE_OBJECTIVE_PEEK_MAX_MISSIONS);
  const position = new Map(served.map((mission, index) => [mission.id, index + 1]));
  const missions: MutableMission[] = [];
  for (const mission of served) {
    const title = line(missionTitle(mission), 64);
    if (!title) continue;
    const premises: number[] = [];
    for (const edge of mission.prerequisites) {
      const at = position.get(edge);
      if (at !== undefined && !premises.includes(at)) premises.push(at);
    }
    const records: string[] = [];
    for (const record of mission.records ?? []) {
      for (const text of record.lines) {
        const kept = prose(text, 160);
        if (kept.length > 0) records.push(kept);
        if (records.length >= 60) break;
      }
      if (records.length >= 60) break;
    }
    missions.push({
      title, text: prose(mission.text, 200), done: mission.done,
      assignee: mission.member != null ? roles.get(mission.member) ?? null : null,
      premises, records,
    });
  }

  const criteria = objective.criteria.slice(0, CONSOLE_OBJECTIVE_PEEK_MAX_CRITERIA).flatMap((criterion) => {
    const text = prose(criterion.text, 300);
    return text.length > 0 ? [{ text, met: criterion.met != null }] : [];
  });

  const results: ConsoleObjectivePeekResult[] = [];
  for (const result of objective.results.slice(0, CONSOLE_OBJECTIVE_PEEK_MAX_RESULTS)) {
    const label = line(result.label ?? "", 120);
    const note = line(result.note ?? "", 300);
    const extra = { ...(label.length > 0 ? { label } : {}), ...(note.length > 0 ? { note } : {}) };
    if (result.kind === "evidence") {
      const name = line(result.name, 120);
      if (!name) continue;
      results.push({ kind: "evidence", ...extra, name, mediaType: result.mediaType, bytes: result.bytes });
      continue;
    }
    const url = peekableUrl(result.url);
    if (!url) continue;
    results.push({ kind: result.kind, ...extra, url });
  }

  const title = line(objective.title, 120);
  const note = prose(objective.note, 20_000);
  const snapshot: MutableSnapshot = {
    v: 1, id: objective.id, title: title.length > 0 ? title : "Objective",
    note: note.length > 0 ? note : null, phase: phaseOf(objective), criteria, missions, members, results,
  };
  if (trimToFit(snapshot)) snapshot.truncated = true;
  return isConsoleObjectivePeek(snapshot) ? snapshot : null;
}

/** 64 KiB 안에 들 때까지 자른다. 잘랐으면 true. */
function trimToFit(snapshot: MutableSnapshot): boolean {
  let cut = false;
  const over = (): boolean => {
    try {
      return Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CONSOLE_OBJECTIVE_PEEK_MAX_BYTES;
    } catch {
      return true;
    }
  };
  // 임무 기록 — 뒤 임무·뒷줄부터 뺀다.
  while (over()) {
    let dropped = false;
    for (let index = snapshot.missions.length - 1; index >= 0; index -= 1) {
      const mission = snapshot.missions[index];
      if (mission && mission.records.length > 0) { mission.records.pop(); dropped = true; cut = true; break; }
    }
    if (!dropped) break;
  }
  // 브리핑 — 반씩 접는다.
  while (over() && snapshot.note) {
    const kept = snapshot.note.slice(0, Math.ceil(snapshot.note.length / 2));
    snapshot.note = kept.length > 0 ? kept : null;
    cut = true;
    if (kept.length === 0) break;
  }
  // 결과물 — 뒤에서 뺀다. 목록 자체가 범위 S라 남는 것만 낸다.
  while (over() && snapshot.results.length > 0) { snapshot.results.pop(); cut = true; }
  return cut;
}
