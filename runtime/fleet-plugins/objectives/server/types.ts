import { z } from "zod";

/**
 * 목표 도메인 — 저장 모양과 화면 모양을 가른다.
 *
 * 목표는 Operation 없이 레코드로 태어난다. 첫 기동 전 제목·그룹·시각·프리셋은 `pending` 에 두고, 개시·구상에서
 * 같은 id 의 지휘관 Operation 을 세운 뒤 `pending` 을 없앤다. 기존 지휘관과 따로 만든 Agent Operation 은 Operation
 * 값에서 화면을 만들고, 검토 대기는 모든 임무와 기준의 충족 여부에서 계산한다.
 */

export const MAX_TITLE = 120;
export const MAX_NOTE = 20_000;
export const MAX_MISSIONS = 40;
export const MAX_MISSION_TEXT = 200;
/** 달성 기준 — 목표가 이루어졌다고 말할 조건. 개수와 길이, 충족 근거 한 줄의 길이. */
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_TEXT = 300;
export const MAX_EVIDENCE = 300;
/** 사람이 지휘관에게 덧붙이는 말(구상·개시·스티어링) — 받는 상한과 프롬프트에 인용하는 상한이 같다. */
export const MAX_CONTEXT = 2000;
/** 임무 기록 한 건의 줄 — 첫 줄이 결론, 나머지는 근거·남은 것. 산문을 한 줄에 몰아넣지 못하게 줄마다 길이를 묶는다. */
export const MAX_RECORD_LINES = 3;
export const MAX_RECORD_LINE = 160;
/** 한 임무에 남기는 기록 수 — 오래된 것부터 밀려난다. */
export const MAX_RECORDS = 20;
/**
 * 후속 후보 — 진행 중 범위 밖에서 찾은 결함·개선점. 지휘관만 올리고, 사람이 완료하며 고른 것만 새 휴면 목표가 된다.
 * 활성(open + 진행 중 selected) 수·본문 길이·근거 수는 저장 무결성을 위한 상한이다.
 */
export const MAX_FOLLOWUPS = 10;
export const MAX_FOLLOWUP_SUMMARY = 160;
export const MAX_FOLLOWUP_BRIEF = 4000;
export const MAX_FOLLOWUP_CRITERIA = 10;
export const MAX_FOLLOWUP_EVIDENCE = 5;
export const MAX_FOLLOWUP_EVIDENCE_TEXT = 300;
export const MAX_FOLLOWUP_NOTE = 200;
/** 폐기 흔적(제목·요약만) — 지휘관이 같은 후보를 다시 올리지 않게 남긴다. 넘치면 오래된 흔적부터 정리한다. */
export const MAX_FOLLOWUP_DISCARDED = 20;
/** 보존하는 완료 배치 — 넘치면 가장 오래된 종결 배치를 누계로 접는다. 진행 중 배치는 접지 않는다. */
export const MAX_FOLLOWUP_BATCHES = 50;

export type SlotBy = "human" | { readonly operationId: string };

export type MemberLaunch = { readonly mode: "same" } | { readonly mode: "model"; readonly model: string; readonly effort?: string };
export type MemberSelection = MemberLaunch | { readonly mode: "route" };

export interface StoredMember {
  readonly id: string;
  readonly role: string;
  readonly brief?: string;
  readonly launch?: MemberLaunch;
  /** 서브에이전트 허용. 없거나 false면 강제 차단이다. true만 저장한다. */
  readonly subagents?: true;
  readonly by: "human" | "commander";
  readonly operationId?: string;
}

export interface ObjectiveMember extends Omit<StoredMember, "launch" | "subagents"> {
  readonly launch: MemberSelection;
  /** 저장된 허용. 키 없음은 false. */
  readonly subagents: boolean;
  readonly sessionName: string | null;
  readonly model?: string;
  readonly effort?: string;
}


/**
 * 메모에 붙인 이미지 — 파일은 그 목표의 디렉터리 안 `attachments/<attachmentId>.<확장자>` 에 있다. 브라우저에 가는 항목에는
 * 경로를 싣지 않는다(파일은 id 로 받아 온다). 절대 경로는 지휘관의 도구 응답에만 실린다.
 */
export interface ObjectiveAttachment {
  readonly id: string;
  /** 「이미지 n」의 n — 붙인 순서로 늘고, 지워도 다른 번호가 밀리지 않는다(메모가 번호로 가리킨다). */
  readonly n: number;
  readonly name: string;
  readonly type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly at: number;
}

/** 지휘관에게 알릴 만한 사람의 편집 — 일정·모델 같은 지휘관의 일과 무관한 값은 넣지 않는다. */
export type ObjectiveEditKind = "title" | "note" | "missions" | "lineup" | "members" | "member" | "criteria";

// ═══ 저장 모양 (목표마다 objective.json) ═════════════════════════════════════

/** 선행 하나 — 선행 임무 id 와, 있으면 그 선행을 둔 이유 한 줄. 사람이 이은 간선은 "human". */
export interface StoredEdge {
  readonly id: string;
  readonly why?: string;
}

/** 임무 기록 — 지휘관이 이 임무를 완료로 표시할 때마다 한 건. 남기는 것은 늘 그 목표의 지휘관이고, 종류(처음·다시)는 위치로 안다. */
export interface StoredRecord {
  readonly id: string;
  readonly at: number;
  /** 1–3줄. 첫 줄이 결론. */
  readonly lines: readonly string[];
}

export interface StoredMission {
  readonly id: string;
  readonly text: string;
  readonly done?: true;
  readonly prerequisites: readonly StoredEdge[];
  /** 담당 구성원 id — 없으면 지휘관 직접. */
  readonly member?: string;
  /** 사람이 담당을 직접 정했다(지휘관 직접 지정도 포함) — 도구가 덮지 않는다. */
  readonly memberBy?: "human";
  /**
   * 미분류 — 사람이 더했고 아직 아무도 선행을 정하지 않은 임무. 준비되지 않으며, 지휘관이 선행을 정하거나
   * 사람이 편성에서 간선·「순서대로」·「병렬」로 직접 정하면 풀린다.
   */
  readonly unplaced?: true;
  readonly records?: readonly StoredRecord[];
  /** 사람이 읽은 기록 수 — 이보다 많으면 안 읽은 기록이 있다. */
  readonly seen?: number;
}

/** 승인된 달성 기준. `met` 은 지휘관이 스스로 따져 충족이라고 판단한 근거 한 줄이다. */
export interface StoredCriterion {
  readonly id: string;
  readonly text: string;
  readonly by: "human" | "commander";
  readonly met?: string;
}

export interface ObjectiveCriterionProposal {
  readonly id: string;
  readonly kind: "add" | "revise" | "retire";
  readonly target?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly annotation?: string;
}

/**
 * 후속 근거 — 발견 위치. 경로는 Theater 루트 기준 상대 경로만 받는다(절대·`~`·`..` 거절). `command` 의 text 는 지휘관이
 * 쓴 재현 명령 원문이라 브리핑·기준과 같은 본문 경계를 따른다.
 */
export type FollowupEvidence =
  | { readonly kind: "file"; readonly path: string; readonly line?: number; readonly note?: string }
  | { readonly kind: "command"; readonly text: string; readonly note?: string }
  | { readonly kind: "artifact"; readonly path: string; readonly note?: string };

/** 후속 후보 본문 — 새 목표의 제목·브리핑·기준이 되고, 요약·근거는 고르는 사람과 새 지휘관이 읽는다. */
export interface FollowupBody {
  readonly title: string;
  readonly summary: string;
  readonly brief: string;
  readonly criteria: readonly string[];
  readonly evidence: readonly FollowupEvidence[];
}

/**
 * 저장된 후보. open 은 지휘관이 고치거나 거둘 수 있고, selected 는 배치에 동결돼 잠기며, discarded 는 사람이 버린 흔적이다
 * (제목·요약만 남는다). 생성이 끝나면(created·deleted) 후보는 목록에서 빠지고 배치 기록에만 남는다.
 */
export interface StoredFollowup extends FollowupBody {
  readonly id: string;
  readonly rev: number;
  readonly state: "open" | "selected" | "discarded";
  readonly at: number;
  readonly updatedAt: number;
  readonly batchId?: string;
  /** 사람이 버린 시각 — 버리는 것은 늘 사람이다. */
  readonly discardedAt?: number;
}

/**
 * 배치 항목의 생성 상태. confirming 은 결과를 확정하지 못한 상태(호스트 조회 불가·저장 실패 등)로, 실패와 다르다 — 같은 키의
 * 재조회만 허용한다. failed 는 호스트가 이 키로 만든 Operation 이 없음을 확정한 실패라 같은 키로 다시 만들 수 있다.
 */
export type FollowupItemState = "creating" | "confirming" | "created" | "failed" | "deleted" | "abandoned";

/** 배치 항목 — 고른 순간의 동결본과 그 생성 결과. 재시도는 같은 스냅샷·같은 키만 쓴다. */
export interface StoredFollowupItem {
  readonly candidateId: string;
  readonly rev: number;
  readonly snapshot: FollowupBody;
  readonly state: FollowupItemState;
  readonly operationId?: string;
  readonly error?: string;
  readonly attempts: number;
  readonly settledAt?: number;
}

/** 완료 한 번에 고른 후보 묶음 — 원본 목표에 남는 영속 생성 기록. id 는 화면이 만든 멱등 키다. */
export interface StoredFollowupBatch {
  readonly id: string;
  readonly at: number;
  /** 고른 순간 동결한 기동 조건 — 원본의 그룹·지휘관 뷰와 알림 언어. 재시도도 이 값을 쓴다. */
  readonly launch: { readonly groupId: string | null; readonly viewMode: "terminal" | "chat"; readonly language: "en" | "ko" };
  readonly items: readonly StoredFollowupItem[];
}

export interface FollowupHistory {
  readonly batches: number;
  readonly created: number;
  readonly deleted: number;
  readonly abandoned: number;
}

/** 후속으로 태어난 목표의 출처 — 원본 목표와 후보. 근거는 새 지휘관이 읽는다. */
export interface StoredOrigin {
  readonly objectiveId: string;
  readonly candidateId: string;
  readonly batchId: string;
  readonly evidence: readonly FollowupEvidence[];
}

export interface PendingCommander {
  readonly theaterId: string;
  readonly title: string;
  readonly groupId: string | null;
  readonly createdAt: number;
  readonly sessionName: string;
  readonly model?: string;
  readonly effort?: string;
  readonly viewMode: "terminal" | "chat";
}

export interface StoredObjective {
  /** 아직 지휘관 Operation 이 없다 — 첫 기동 때 제거한다. */
  readonly pending?: PendingCommander;
  /** 목표 id — 지휘관이 태어나면 그 Operation id 이기도 하다. */
  readonly operationId: string;
  /**
   * 보드 자리 — 유한 실수 하나. 보드는 이 값의 오름차순이고 동률은 만든 시각으로 가른다. 옮기면 이웃 사이의 중간값을
   * 받으므로 그 목표의 파일 한 건만 바뀐다(중간값이 더 나오지 않을 때만 전체를 정수로 다시 번호 붙인다).
   */
  readonly rank: number;
  readonly note: string;
  /** 구상에 함께 주는 맥락 — 지휘관이 임무를 짤 때 읽는 사람의 프롬프트. */
  readonly planRequest?: string;
  /** 구상 중 — 지휘관이 임무·메모만 짜는 국면. 시작·중지·완료가 끝낸다. */
  readonly planning?: true;
  /** 사람의 명시적인 구상 요청에서만 켜고, 스티어링·개시·중지·완료에서 끈다. */
  readonly criteriaOpen?: true;
  readonly attachments?: readonly ObjectiveAttachment[];
  readonly dueDate?: string;
  readonly today?: true;
  /** 에이전트가 도구로 더한 목표 — 더한 Operation. 사람이 만든 목표에는 없다. */
  readonly addedBy?: string;
  /**
   * 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것 — 「시작」·「스티어링」이 지휘관에게 한 줄로 알리고 다시 읽게 한다.
   * 지휘관이 이 항목을 읽거나 알림이 나가면 지워진다.
   */
  readonly edited?: { readonly at: number; readonly kinds: readonly ObjectiveEditKind[] };
  /** 목표 완료 — 완료는 늘 사람이 누른다. */
  readonly done?: { readonly at: number };
  readonly criteria?: readonly StoredCriterion[];
  readonly criteriaProposals?: readonly ObjectiveCriterionProposal[];
  readonly members?: readonly StoredMember[];
  readonly followups?: readonly StoredFollowup[];
  readonly followupBatches?: readonly StoredFollowupBatch[];
  readonly followupHistory?: FollowupHistory;
  readonly origin?: StoredOrigin;
  readonly missions: readonly StoredMission[];
}

/**
 * 저장 구조 — Theater 의 목표 폴더는 목표마다 디렉터리 하나다.
 *
 * ```
 * workspaces/<프로젝트>/objectives/<objectiveId>/objective.json
 * workspaces/<프로젝트>/objectives/<objectiveId>/attachments/<attachmentId>.<확장자>
 * ```
 *
 * `objective.json` 은 `StoredObjective` 그대로이고, 디렉터리 이름은 그 안의 `operationId` 와 같아야 한다(어긋나거나 깨진
 * 파일은 `objective.json.broken-<ts>` 로 비켜 두고 그 목표만 빈 목표로 본다). 목표 목록은 이 폴더를 한 번 읽어 올린다.
 */
export const OBJECTIVE_FILE = "objective.json";

// ═══ 화면 모양 (서버가 Operation 과 합쳐 만든다) ═══════════════════════════

export interface MissionRecord {
  readonly id: string;
  readonly at: number;
  /** 처음 완료인지, 기록이 이미 있는 임무를 다시 완료한 것인지 — 위치에서 나온다. */
  readonly kind: "done" | "redone";
  readonly lines: readonly string[];
}

export interface ObjectiveMission {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  /** 선행 임무 id. 전부 완료돼야 이 임무가 준비된다. */
  readonly prerequisites: readonly string[];
  /** 선행마다 붙는 이유 한 줄(선행 id → why). */
  readonly why: Readonly<Record<string, string>>;
  readonly member: string | null;
  readonly memberBy?: "human";
  readonly unplaced?: true;
  /** 담당 Operation — 위임했을 때만. */
  readonly operationId: string | null;
  /** 담당 세션 이름·모델·강도 — 담당 Operation 에서 읽는다. */
  readonly sessionName: string | null;
  readonly model?: string;
  readonly effort?: string;
  readonly records: readonly MissionRecord[];
  readonly seen: number;
}

export interface ObjectiveCriterion {
  readonly id: string;
  readonly text: string;
  readonly by: "human" | "commander";
  /** 충족 근거 — 지휘관이 충족으로 표시했을 때만. */
  readonly met?: string;
}

export interface Objective {
  /** 지휘관 Operation id. */
  readonly id: string;
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly title: string;
  readonly createdAt: number;
  /** 지휘관 세션 — 이름·모델·강도·한 번이라도 깨었는지는 지휘관 Operation 에서 읽는다. */
  readonly commander: { readonly sessionName: string | null; readonly model?: string; readonly effort?: string; readonly viewMode?: "terminal" | "chat"; readonly started: boolean };
  readonly note: string;
  readonly attachments: readonly ObjectiveAttachment[];
  readonly planRequest?: string;
  readonly planning: boolean;
  readonly criteriaOpen: boolean;
  readonly edited?: { readonly at: number; readonly kinds: readonly ObjectiveEditKind[] };
  readonly dueDate: string | null;
  readonly today: boolean;
  readonly addedBy: { readonly operationId: string; readonly title: string | null } | null;
  readonly done: { readonly at: number } | null;
  /** 검토 대기 — 끝나지 않은 목표의 모든 임무와 모든 달성 기준이 끝났다. 저장하지 않고 계산한다. 완료는 사람이 누른다. */
  readonly awaitingReview: boolean;
  readonly criteria: readonly ObjectiveCriterion[];
  readonly criteriaProposals: readonly ObjectiveCriterionProposal[];
  readonly members: readonly ObjectiveMember[];
  readonly missions: readonly ObjectiveMission[];
  /** 후속 후보 — open·selected·discarded. discarded 는 제목·요약만. */
  readonly followups: readonly ObjectiveFollowup[];
  /** 완료 때 고른 묶음과 생성 결과(영속). */
  readonly followupBatches: readonly ObjectiveFollowupBatch[];
  readonly followupHistory: FollowupHistory | null;
  /** 이 목표가 후속으로 태어났다면 원본과 후보. 원본이 사라졌으면 title 은 null. */
  readonly origin: { readonly objectiveId: string; readonly title: string | null; readonly candidateId: string; readonly evidence: readonly ObjectiveFollowupEvidenceView[] } | null;
}

export interface ObjectiveFollowupEvidenceView {
  readonly kind: FollowupEvidence["kind"];
  readonly path: string | null;
  readonly line: number | null;
  readonly text: string | null;
  readonly note: string | null;
}

export interface ObjectiveFollowup {
  readonly id: string;
  readonly rev: number;
  readonly state: StoredFollowup["state"];
  readonly title: string;
  readonly summary: string;
  readonly brief: string;
  readonly criteria: readonly string[];
  readonly evidence: readonly ObjectiveFollowupEvidenceView[];
  readonly at: number;
  readonly updatedAt: number;
  readonly batchId: string | null;
  readonly discarded: { readonly at: number; readonly by: "human" } | null;
}

export interface ObjectiveFollowupBatch {
  readonly id: string;
  readonly at: number;
  readonly items: readonly {
    readonly candidateId: string;
    readonly rev: number;
    readonly snapshot: { readonly title: string; readonly summary: string; readonly brief: string; readonly criteria: readonly string[]; readonly evidence: readonly ObjectiveFollowupEvidenceView[] };
    readonly state: FollowupItemState;
    readonly operationId: string | null;
    readonly error: string | null;
    readonly attempts: number;
    readonly settledAt: number | null;
  }[];
}

/** 근거의 화면 모양 — 종류별 필드를 한 모양으로 편다. 경로는 저장 때 이미 Theater 상대로 검사됐다. */
export const evidenceView = (evidence: FollowupEvidence): ObjectiveFollowupEvidenceView => ({
  kind: evidence.kind,
  path: evidence.kind === "command" ? null : evidence.path,
  line: evidence.kind === "file" ? evidence.line ?? null : null,
  text: evidence.kind === "command" ? evidence.text : null,
  note: evidence.note ?? null,
});
/** 끝난 배치 항목 — 더는 바뀌지 않는다(failed·confirming 은 재시도·재조회가 남았다). */
export const followupSettled = (state: FollowupItemState): boolean => state === "created" || state === "deleted" || state === "abandoned";

export const latestRecord = (mission: { readonly records: readonly MissionRecord[] }): MissionRecord | null => mission.records.at(-1) ?? null;
export const unseenRecords = (mission: { readonly records: readonly MissionRecord[]; readonly seen: number }): number => Math.max(0, mission.records.length - mission.seen);

/**
 * 지휘관의 요약을 기록의 줄로 — 빈 줄은 버리고, 1–3줄이며 줄마다 160자 이하여야 한다. 맞지 않으면 null(도구가 거절한다).
 */
export function recordLines(summary: readonly string[]): readonly string[] | null {
  const lines = summary.map((line) => line.trim().replace(/^[·•*-]\s+/, "")).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_RECORD_LINES) return null;
  return lines.every((line) => line.length <= MAX_RECORD_LINE) ? lines : null;
}

/** 검토 대기 — 임무가 하나 이상 있고 모두 끝났으며, 달성 기준이 모두 충족으로 표시됐다. */
export function awaitingReview(objective: Pick<StoredObjective, "done" | "missions" | "criteria" | "criteriaProposals">): boolean {
  if (objective.done || objective.missions.length === 0 || objective.criteriaProposals?.length) return false;
  return objective.missions.every((mission) => mission.done) && (objective.criteria ?? []).every((criterion) => !!criterion.met);
}

/** 기준의 충족 표시를 모두 거둔다 — 새 작업이 생기면 앞선 판단은 옛 보드에 대한 것이다. */
export function withoutMet<T extends Pick<StoredObjective, "criteria">>(objective: T): T {
  if (!objective.criteria?.some((criterion) => criterion.met)) return objective;
  return { ...objective, criteria: objective.criteria.map(({ met: _met, ...rest }) => rest) };
}

// ═══ 편성(의존 그래프) ═══════════════════════════════════════════════════════

/** 그래프 계산이 보는 임무의 최소 모양 — 저장 임무와 화면 임무 모두 이 모양으로 읽힌다. */
export interface GraphMission {
  readonly id: string;
  readonly done?: boolean;
  readonly prerequisites: readonly string[];
  readonly unplaced?: true;
}

export const graphOf = (missions: readonly StoredMission[]): readonly GraphMission[] => missions.map((mission) => ({ id: mission.id, done: !!mission.done, prerequisites: mission.prerequisites.map((edge) => edge.id), ...(mission.unplaced ? { unplaced: true as const } : {}) }));

/** 준비 — 미분류 임무는 자리가 정해질 때까지 준비되지 않는다. 선행 없는 임무가 곧 「병렬」로 읽히는 것을 막는다. */
export function missionReady(missions: readonly GraphMission[], mission: GraphMission): boolean {
  if (mission.unplaced) return false;
  return mission.prerequisites.every((id) => missions.find((candidate) => candidate.id === id)?.done ?? true);
}

/** 지휘관의 모드 — 라벨이 아니라 매번 그래프에서 계산한다. */
export type CommanderMode = "direct" | "coordinate" | "mixed";

export function commanderMode(missions: readonly { readonly done?: boolean; readonly member?: string | null }[]): CommanderMode {
  const open = missions.filter((mission) => !mission.done);
  if (open.length === 0) return "direct";
  const assigned = open.filter((mission) => mission.member).length;
  if (assigned === 0) return "direct";
  return assigned === open.length ? "coordinate" : "mixed";
}

/** 간선 추가가 순환을 만드는지 — `from` 이 `to` 의 후손이면 순환. */
export function wouldCycle(missions: readonly GraphMission[], from: string, to: string): boolean {
  if (from === to) return true;
  const byId = new Map(missions.map((mission) => [mission.id, mission]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of byId.get(current)?.prerequisites ?? []) stack.push(parent);
  }
  return false;
}

/** 편성에 아직 자리가 없는 임무 — 사람이 선행 없이 더했고 끝나지 않았다. 그래프의 「미분류」 칸과 목록 맨 아래에 선다. */
export const isLoose = (mission: GraphMission): boolean => !!mission.unplaced && !mission.done;

/**
 * 편성 열 — 가장 긴 선행 사슬의 길이(선행 없음 = 0). 그래프의 열 배치와 임무 순서가 같은 값을 쓴다.
 */
export function missionDepths(missions: readonly GraphMission[]): Map<string, number> {
  const byId = new Map(missions.map((mission) => [mission.id, mission]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const mission = byId.get(id);
    const value = mission && mission.prerequisites.length ? Math.max(...mission.prerequisites.map((parent) => (byId.has(parent) ? depthOf(parent, seen) + 1 : 0))) : 0;
    depth.set(id, value);
    return value;
  };
  for (const mission of missions) if (!isLoose(mission)) depthOf(mission.id, new Set());
  return depth;
}

/**
 * 편성 순 — 목록·번호·지휘관 도구의 index·담당 세션 이름이 모두 이 순서를 쓴다.
 * 열(깊이)이 앞선 임무가 먼저, 같은 열이면 지금 순서를 지킨다. 미분류 임무는 지금 순서대로 맨 아래.
 * 이미 편성 순이면 같은 배열을 돌려준다.
 */
export function lineupOrder<S extends StoredMission>(missions: readonly S[]): readonly S[] {
  const graph = graphOf(missions);
  const depth = missionDepths(graph);
  const at = new Map(missions.map((mission, index) => [mission.id, index]));
  const rank = (mission: S, index: number) => (isLoose(graph[index]!) ? Number.MAX_SAFE_INTEGER : depth.get(mission.id) ?? 0);
  const ranked = missions.map((mission, index) => ({ mission, rank: rank(mission, index) }));
  const sorted = [...ranked].sort((a, b) => a.rank - b.rank || at.get(a.mission.id)! - at.get(b.mission.id)!).map((entry) => entry.mission);
  return sorted.every((mission, index) => mission === missions[index]) ? missions : sorted;
}

export function hasCycle(missions: readonly GraphMission[]): boolean {
  const byId = new Map(missions.map((mission) => [mission.id, mission]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(id, 1);
    for (const parent of byId.get(id)?.prerequisites ?? []) if (byId.has(parent) && visit(parent)) return true;
    state.set(id, 2);
    return false;
  };
  return missions.some((mission) => visit(mission.id));
}

// ═══ wire schemas ═════════════════════════════════════════════════════════════

const ids = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(MAX_TITLE);
const note = z.string().max(MAX_NOTE);
const missionText = z.string().trim().min(1).max(MAX_MISSION_TEXT);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const createObjectiveSchema = z.object({
  theaterId: ids,
  viewMode: z.enum(["terminal", "chat"]).optional(),
  language: z.enum(["en", "ko"]).optional(),
  groupId: ids.nullable().optional(),
  title,
  note: note.optional(),
  dueDate: dueDate.optional(),
  today: z.boolean().optional(),
  /** 선행은 이 목록 안의 1-based 임무 번호 — 앞에 선 임무만 가리킨다. */
  missions: z.array(z.object({ text: missionText, prerequisites: z.array(z.number().int().min(1)).optional() })).max(MAX_MISSIONS).optional(),
}).strict();

export const patchObjectiveSchema = z.object({
  title: title.optional(),
  note: note.optional(),
  planRequest: z.string().max(MAX_CONTEXT).optional(),
  dueDate: dueDate.optional(),
  today: z.boolean().optional(),
  groupId: ids.nullable().optional(),
  /** 지휘관 모델·강도 — 지휘관 Operation 에 쓴다. */
  launch: z.object({ model: z.string().max(128).optional(), effort: z.string().max(32).optional(), viewMode: z.enum(["terminal", "chat"]).optional() }).strict().optional(),
}).strict();

export const memberLaunchSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("same") }).strict(),
  z.object({ mode: z.literal("model"), model: z.string().trim().min(1).max(128), effort: z.string().max(32).optional() }).strict(),
]);
export const memberAddSchema = z.object({ role: z.string().trim().min(1).max(40), brief: z.string().max(300).optional(), launch: memberLaunchSchema.optional(), subagents: z.boolean().optional() }).strict();
export const memberPatchSchema = z.object({ role: memberAddSchema.shape.role.optional(), brief: z.string().max(300).nullable().optional(), launch: memberLaunchSchema.nullable().optional(), subagents: z.boolean().optional() }).strict();
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
export const criterionAddSchema = z.object({ text: criterionText }).strict();
export const criterionPatchSchema = z.object({ text: criterionText }).strict();
export const criterionProposalSchema = z.union([
  z.object({ text: criterionText }).strict(),
  z.object({ revise: z.union([z.number().int().min(1), ids]), text: criterionText }).strict(),
  z.object({ retire: z.union([z.number().int().min(1), ids]), reason: criterionText }).strict(),
]);
export type CriterionProposalInput = z.output<typeof criterionProposalSchema>;

export const missionAddSchema = z.object({ text: missionText, prerequisites: z.array(ids).max(MAX_MISSIONS).optional(), member: ids.nullable().optional() }).strict();
export const missionPatchSchema = z.object({
  text: missionText.optional(),
  done: z.boolean().optional(),
  prerequisites: z.array(ids).max(MAX_MISSIONS).optional(),
  why: z.record(ids, z.string().max(300)).optional(),
  /** null 이면 지휘관 직접. */
  member: ids.nullable().optional(),
}).strict();

export const planSchema = z.object({
  missions: z.array(z.object({
    text: missionText,
    // n 은 이 plan 의 missions 안 1-based 번호, missionId 는 이미 있는(완료·배정된) 임무 — 새 임무가 기존 임무 뒤에 설 수 있다.
    prerequisites: z.array(z.object({ n: z.number().int().min(1).optional(), missionId: ids.optional(), why: z.string().max(300).optional() })).max(MAX_MISSIONS).optional(),
    /** 구성원 id 또는 역할 이름. 없으면 지휘관 직접. */
    member: ids.optional(),
  })).min(1).max(MAX_MISSIONS),
  members: z.array(memberAddSchema.pick({ role: true, brief: true })).max(MAX_MISSIONS).optional(),
  criteria: z.array(criterionProposalSchema).max(MAX_CRITERIA).optional(),
}).strict();

/** 한 줄 본문 — 줄바꿈·제어 문자 없이. */
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
/**
 * Theater 루트 기준 상대 경로 — 어휘 검사만 한다(파일을 열지 않는다). 절대 경로·홈(`~`)·드라이브·역슬래시·`..` 구간은
 * 받지 않는다. 브라우저에 가는 근거에 이 기계의 경로가 실리지 않게 하는 경계다.
 */
export const relativePath = oneLine(MAX_FOLLOWUP_EVIDENCE_TEXT).refine((value) => !/^[/~\\]/.test(value) && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.split("/").some((segment) => segment === ".."), { message: "relative_path" });
const evidenceNote = oneLine(MAX_FOLLOWUP_NOTE).optional();
export const followupEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: relativePath, line: z.number().int().min(1).optional(), note: evidenceNote }).strict(),
  z.object({ kind: z.literal("command"), text: oneLine(MAX_FOLLOWUP_EVIDENCE_TEXT), note: evidenceNote }).strict(),
  z.object({ kind: z.literal("artifact"), path: relativePath, note: evidenceNote }).strict(),
]);
const followupFields = {
  title,
  summary: oneLine(MAX_FOLLOWUP_SUMMARY),
  brief: z.string().trim().min(1).max(MAX_FOLLOWUP_BRIEF),
  criteria: z.array(z.string().trim().min(1).max(MAX_CRITERION_TEXT)).min(1).max(MAX_FOLLOWUP_CRITERIA),
  evidence: z.array(followupEvidenceSchema).min(1).max(MAX_FOLLOWUP_EVIDENCE),
};
export const followupBodySchema = z.object(followupFields).strict();
export const followupReviseSchema = z.object({ title: followupFields.title.optional(), summary: followupFields.summary.optional(), brief: followupFields.brief.optional(), criteria: followupFields.criteria.optional(), evidence: followupFields.evidence.optional() }).strict();
export type FollowupBodyInput = z.output<typeof followupBodySchema>;
export type FollowupReviseInput = z.output<typeof followupReviseSchema>;
/** 완료와 함께 고른 후보 — 화면이 본 rev 와 함께. batchId 는 화면이 만든 멱등 키(UUID). */
export const followupSelectionSchema = z.object({
  batchId: z.string().uuid(),
  followups: z.array(z.object({ id: ids, rev: z.number().int().min(1) }).strict()).min(1).max(MAX_FOLLOWUPS),
});

export type CreateObjectiveInput = z.output<typeof createObjectiveSchema>;
export type PatchObjectiveInput = z.output<typeof patchObjectiveSchema>;
export type MemberPatchInput = z.output<typeof memberPatchSchema>;
export type MissionAddInput = z.output<typeof missionAddSchema>;
export type MissionPatchInput = z.output<typeof missionPatchSchema>;
export type PlanInput = z.output<typeof planSchema>;

/** 브라우저·Console Use 양쪽으로 나가는 사건 프레임. */
export const OBJECTIVE_CHANNEL = "objectives:objective";
export interface ObjectiveEvent {
  readonly op: "upsert" | "remove";
  readonly theaterId: string;
  readonly objectiveId: string;
  readonly objective?: Objective;
  /** 순서가 바뀌었을 때만 — 그 Theater 항목 id 의 새 순서 전체. 받는 쪽은 이 순서로 다시 줄 세운다. */
  readonly order?: readonly string[];
}
