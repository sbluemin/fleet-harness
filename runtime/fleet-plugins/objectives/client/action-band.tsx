import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { MAX_CONTEXT, ROUTING_PREVIEW_TTL_MS, type ObjectiveEditKind, type Objective, type ObjectiveMember, type RoutingPreview } from "../server/types.js";
import { LaunchControl, LaunchedText, launchedWords, routingReason, useLaunchRows } from "./launch-control.js";
import { nonHumanEditors } from "./actors.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import {
  clearSelection,
  discardedFollowups,
  isFollowupSelectable,
  newBatchId,
  openFollowups,
  pruneSelection,
  readSelectionRevs,
  setFollowupOpen,
  toggleFollowupSelection,
  useFollowupOpen,
  useFollowupSelection,
} from "./followups.js";
import { FollowupCandidateList, FollowupDiscardedTrace } from "./followups-view.js";
import { SyncedTextarea } from "@fleet-console/sdk/composer";
import { SettingsToggle } from "@fleet-console/sdk/settings/browser";

type T = Translate<ObjectiveMessageKey>;

/**
 * 하단 한 자리 — 지금 할 한 가지를 말한다. 같은 상태에서 함께 성립하는 다른 한 가지는 버튼을 늘리지 않고, 누르면 이 자리가
 * 위로 펼쳐져 그 안에서 고른다. 지휘관에게 말을 거는 행동(구상·개시·스티어링)은 모두 같은 칸으로 덧붙일 말을 받는다.
 * 완료·결정 대기·중단은 펼칠 것이 없으면 누르는 즉시 실행한다.
 *
 * 우선순위 — 사람이 지금 무엇을 해야 하나: 완료됨 > 지휘관 결정 대기 > 작업 중(구성원 실행 포함) > 구성원 결정 대기 >
 * 검토 대기 > 인계 대기 > 깨운 뒤 유휴 > 개시 전. 인계 대기에서 쉬는 지휘관 대신 사람이 「검토로 넘기기」를 쓸 수 있다 — 한 번 누름으로
 * 넘어가지 않게 지휘관 깨우기와 함께 펼쳐 고른다. 지휘관이 마지막으로 읽은 뒤 사람이 보드를 고쳤으면 낱말은 상태와 상관없이 「스티어링」이고,
 * 서버 경로는 상태가 고른다(쉬는 구성원까지 깨워야 하는 유휴는 개시 경로, 작업 중·검토 대기·구상 중은 스티어링 경로).
 * 달성 기준 제안이 남아 있으면 개시·스티어링은 잠긴 띠로 서고(서버가 criteria_pending 으로 거부한다), 그 아래 「다시 구상」만 열린다.
 */

type IntentKey = "plan" | "replan" | "start" | "resume" | "steer" | "steerIdle" | "complete" | "handOff" | "decide" | "decideMember" | "stop" | "message" | "extend";

interface Intent {
  readonly word: string;
  readonly desc: string;
  /** 지휘관에게 말을 건다 — 덧붙일 말을 받는다. */
  readonly talk: boolean;
  readonly tone?: "stop" | "aurora";
  readonly glyph?: ReactNode;
  readonly placeholder?: string;
  readonly run: (context: string) => Promise<unknown>;
}

export interface MemberAwaiting {
  readonly operationId: string;
  readonly role: string;
  /** 그 구성원이 맡은 끝나지 않은 첫 임무의 번호(1부터). 없으면 null. */
  readonly mission: number | null;
}

/** 메시지를 받을 수 있는 세션 — 지휘관과 세션이 있는 구성원. state 는 그 세션의 활동(idle·running·background·awaiting·ended). */
export interface MessageRecipient {
  /** 지휘관은 목표 id, 구성원은 구성원 id(곧 그 Operation id). */
  readonly id: string;
  readonly role: string;
  readonly mark: ReactNode;
  readonly state: string;
  readonly outcome?: string;
}

export interface ActionBandProps {
  readonly objective: Objective;
  readonly t: T;
  /** 지휘관이 일한다(running·background, 구성원 활동을 끌어올린 값) — 편집 잠금과 같은 기준. */
  readonly busy: boolean;
  /** 지휘관 자신이나 구성원 누군가가 일한다. */
  readonly working: boolean;
  /** 지휘관 자신이 사람의 결정을 기다린다(끌어올리기 전 값 — 구성원의 대기는 memberAwaiting). */
  readonly commanderAwaiting: boolean;
  readonly memberAwaiting: MemberAwaiting | null;
  readonly launchAvailable: boolean;
  /** 지휘관 상태 낱말(유휴·끝남 …) — 「개시」 부제에 쓴다. */
  readonly commanderState: string;
  readonly commanderExists: boolean;
  /** 「메시지」의 받는 이 — 첫 칸이 지휘관이다. 비어 있으면 「메시지」를 두지 않는다. */
  readonly recipients: readonly MessageRecipient[];
  /** 받는 이 상태 낱말 — 명단 줄과 같은 말(쉬는 중·작업 중·허용 대기·휴면). */
  readonly stateWord: (state: string, outcome?: string) => string;
  /** 실패하면 코드를 message 로 던진다. */
  readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  readonly onFocusOperation: (operationId: string) => void;
  /** 개시가 라우팅으로 새로 띄울 구성원 — 있으면 「개시 전 라우팅 결과 확인」 스위치가 선다. */
  readonly routingTargets: readonly ObjectiveMember[];
  /** 이미 띄운 구성원인가 — 확인 시트에서 그대로 재개할 줄로 선다. */
  readonly memberLaunched: (member: ObjectiveMember) => boolean;
  readonly memberMark: (memberId: string) => ReactNode;
}

/** 라우팅 확인 시트 — 판단 중(judging)·본 결과를 갱신 중(refreshing)·결과(ready). overridden 은 시트에서 직접 지정으로 바꾼 구성원이다. */
interface RoutingSheet {
  readonly phase: "judging" | "refreshing" | "ready";
  readonly preview: RoutingPreview | null;
  /** 시트에서 직접 지정한 값 — 저장이 방송으로 돌아오기 전에도 행이 그 모델을 말한다. */
  readonly overridden: ReadonlyMap<string, { readonly model: string; readonly effort?: string }>;
  /** 이 시트에서 본 판단 결과 — 다시 읽어도 직접 지정으로 대상에서 빠진 구성원의 결과를 남긴다. */
  readonly known: ReadonlyMap<string, RoutingPreview["members"][number]>;
  readonly error: string | null;
}
/** 대상 전원에 걸친 사유 — 항목별 사유가 아니라 판단 자체가 돌지 못했다. 시트 위에 띠로 선다. */
const SET_WIDE_REASONS = new Set(["routing_disabled", "routing_timeout", "routing_unavailable", "routing_failed"]);
const NOTICE_MS = 6000;
const Spinner = () => <span className="objectives-routing-spinner" aria-hidden="true" />;

const WandGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 13l7-7M10 3l.6 1.6L12.2 5l-1.6.6L10 7.2 9.4 5.6 7.8 5l1.6-.6zM13 9l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" /></svg>;
const StartGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 3.5l8 4.5-8 4.5z" /></svg>;
const SteerGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 11.5c2-4 5-6 11-6M10.5 2.5l3 3-3 3" /></svg>;
const LockGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
const HandOffGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8h8M7.5 4.5 11 8l-3.5 3.5M13.5 3v10" /></svg>;
const StopGlyph = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>;
const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
/** 위아래에서 가운데로 모이는 화살표 — 컨텍스트 압축(/compact). */
const CompactGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.75v4M5.75 3.75 8 6l2.25-2.25M8 14.25v-4M5.75 12.25 8 10l2.25 2.25M3 8h10" /></svg>;
/** 말풍선 — 받는 이에게 한 마디. */
const MessageGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7.5l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" /></svg>;
const CheckGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>;
const DecideDot = () => <i className="objectives-start-dot" aria-hidden="true" />;
/** 카드 이동(objectives-panel.tsx의 GoGlyph)과 같은 path — 크기는 CSS가 정한다. */
const GoGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;

const COUNT_FROM = 1800;
/** 압축 두 번 누름 — 첫 누름 뒤 이 안에 다시 눌러야 보낸다. 결과 체크와 결과 부제는 각각 이만큼 보인다. */
const COMPACT_ARM_MS = 4000;
const COMPACT_DONE_MS = 1600;
const COMPACT_RESULT_MS = 5000;
/** 보낸 메시지의 흔적 — 띠 부제에 이만큼 선다. */
const SENT_NOTE_MS = 5000;
/** 받는 이 상태 → 보내면 어떻게 닿는지. 큐잉·깨움·거절은 호스트 전달 경로가 정하고, 이 낱말은 그 사실을 옮긴다. */
const HOW_KEYS: Readonly<Record<string, ObjectiveMessageKey>> = {
  running: "objectives.band.message.how.working",
  background: "objectives.band.message.how.working",
  ended: "objectives.band.message.how.dormant",
  awaiting: "objectives.band.message.how.awaiting",
};
interface CompactResult { readonly requested: number; readonly woken: number; readonly rejected: number; readonly excluded: number }
/**
 * 초안 — 접어도, 다른 목표를 보다 와도, 레일↔확대로 자리를 옮겨도 남는다(목표 id 별, 이 탭의 메모리). 보내면 비운다.
 * 플러그인 번들 안에서만 쓰는 보기 상태라 호스트와 나누지 않는다.
 */
const drafts = new Map<string, string>();
/** 한글 IME 조합 중의 Enter 와 길게 눌러 반복된 Enter 는 보내지 않는다. Shift+Enter 는 줄바꿈이다. */
const sendKey = (event: ReactKeyboardEvent<HTMLElement>): boolean => event.key === "Enter" && !event.shiftKey && !event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229;

const EDIT_KEYS: Readonly<Record<ObjectiveEditKind, ObjectiveMessageKey>> = {
  title: "objectives.edit.title",
  note: "objectives.edit.note",
  missions: "objectives.edit.missions",
  lineup: "objectives.edit.lineup",
  members: "objectives.edit.members",
  member: "objectives.edit.member",
  criteria: "objectives.edit.criteria",
};

const REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  objective_busy: "objectives.band.reason.busy",
  slot_taken: "objectives.band.reason.taken",
  session_awaiting_input: "objectives.band.reason.awaiting",
  launch_failed: "objectives.band.reason.undelivered",
  claude_trust_required: "objectives.band.reason.trustRequired",
  launch_unavailable: "objectives.band.reason.unavailable",
  objective_done: "objectives.band.reason.done",
  criteria_pending: "objectives.band.reason.criteriaPending",
  criteria_not_planning: "objectives.band.reason.criteriaNotPlanning",
  followup_changed: "objectives.band.reason.followupChanged",
  followup_capacity: "objectives.band.reason.followupCapacity",
  too_many_followups: "objectives.band.reason.followupTooMany",
  followup_backlog: "objectives.band.reason.followupBacklog",
  steer_required: "objectives.band.reason.steerRequired",
  not_in_review: "objectives.band.reason.notInReview",
  not_awaiting_handoff: "objectives.band.reason.notAwaitingHandoff",
  routing_preview_stale: "objectives.band.reason.routingStale",
};

/** 메시지의 거절은 지휘관이 아니라 받는 이의 사정이다. */
const MESSAGE_REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  session_awaiting_input: "objectives.band.reason.recipientAwaiting",
  unknown_member: "objectives.band.reason.recipientGone",
  unknown_operation: "objectives.band.reason.recipientGone",
  session_not_found: "objectives.band.reason.recipientGone",
  // 세션 좌표가 남지 않은 휴면 세션 — 이어 붙일 세션이 없어 깨울 수 없다.
  capability_unavailable: "objectives.band.reason.recipientUnreachable",
  resume_unavailable: "objectives.band.reason.recipientUnreachable",
};

/** 실패 코드를 띠의 사유 한 줄로 — 메시지의 거절은 받는 이의 사정이 먼저다. 모바일 ⋮ 도 같은 문구를 쓴다. */
export function bandFailure(t: T, error: unknown, options: { readonly message: boolean; readonly talk: boolean }): string {
  const code = error instanceof Error ? error.message : "unknown";
  const reasonKey = options.message ? MESSAGE_REASONS[code] ?? REASONS[code] : REASONS[code];
  const reason = reasonKey ? t(reasonKey) : t("objectives.band.reason.other", { code });
  return t(options.talk ? "objectives.band.failed" : "objectives.band.failedAction", { reason });
}

type ChooseInput = Pick<ActionBandProps, "objective" | "working" | "commanderAwaiting" | "memberAwaiting">;

/** 지금 상태의 주행동과, 펼치면 함께 고르는 것. 제안이 남아 잠긴 개시·스티어링은 gated 가 말한다(주행동은 「다시 구상」). */
function choose(props: ChooseInput): { readonly primary: IntentKey | null; readonly alts: readonly IntentKey[]; readonly gated?: true } {
  const { objective, working, commanderAwaiting, memberAwaiting } = props;
  if (objective.done) return { primary: "extend", alts: [] };
  const started = objective.commander.started;
  // 한 번도 깨지 않은 지휘관은 보드를 처음부터 읽는다 — 그 전의 편집은 알릴 것이 아니다.
  const edited = started && (objective.edited?.kinds.length ?? 0) > 0;
  if (commanderAwaiting) return { primary: "decide", alts: [] };
  if (working) return edited ? { primary: "steer", alts: ["stop"] } : { primary: "stop", alts: [] };
  if (memberAwaiting) return { primary: "decideMember", alts: [] };
  if (objective.criteriaProposals.length > 0) return { primary: "replan", alts: [], gated: true };
  if (objective.awaitingReview) return edited ? { primary: "steer", alts: ["extend", "replan"] } : { primary: "complete", alts: ["extend"] };
  if (objective.awaitingHandoff) return edited ? { primary: "steerIdle", alts: ["handOff"] } : { primary: "handOff", alts: [started ? "resume" : "start"] };
  // 구상이 끝나 개시를 기다린다 — 편집이 있으면 편성을 이어서 짜게 알리고(스티어링), 개시도 여기서 고른다.
  if (started && objective.planning) return edited ? { primary: "steer", alts: ["start"] } : { primary: "start", alts: ["replan"] };
  if (started) return edited ? { primary: "steerIdle", alts: ["replan"] } : { primary: "resume", alts: ["replan"] };
  return objective.missions.length === 0 ? { primary: "plan", alts: ["start"] } : { primary: "start", alts: ["plan"] };
}

/** 띠가 지금 고를 수 있는 할 일 — 주행동·펼침 목록·후속 후보 펼침·메시지 가능 여부. 모바일 ⋮ 가 같은 판정을 쓴다. */
export function bandChoices(props: ChooseInput & { readonly commanderExists: boolean; readonly recipientCount: number }) {
  const { objective } = props;
  const { primary, alts: stateAlts, gated } = choose(props);
  // 후속 후보(A안) — 검토 대기 + 후보 1건 이상 + edited 아님이 `complete` 와 겹치면 띠는 바로 완료하지 않고 위로 펼쳐 고른다.
  // 후보가 없으면 기존 완료 띠 그대로다. 선택은 완료를 누르기 전까지 로컬 초안이다.
  const followupCandidates = openFollowups(objective);
  const followupAvailable = primary === "complete" && !gated && isFollowupSelectable(objective) && followupCandidates.length > 0;
  // 「메시지」 — 깨어난 지휘관이 있으면 어느 상태에서든 펼친 칸에서 고른다. 결정 대기(띠 자체가 이동)·후속 후보·잠긴 띠는 제 할 일이 먼저다.
  const messageable = !!primary && !objective.done && objective.commander.started && props.commanderExists && props.recipientCount > 0
    && primary !== "decide" && primary !== "decideMember" && !gated && !followupAvailable;
  const alts: readonly IntentKey[] = messageable ? [...stateAlts, "message"] : stateAlts;
  return { primary, alts, gated, followupCandidates, followupAvailable };
}

export function ActionBand(props: ActionBandProps) {
  const { objective, t, request, recipients } = props;
  const { primary, alts, gated, followupCandidates, followupAvailable } = bandChoices({ ...props, recipientCount: recipients.length });
  const followupSelection = useFollowupSelection(objective.id);
  const followupOpen = useFollowupOpen(objective.id);
  const [followupOpenId, setFollowupOpenId] = useState<string | null>(null);
  const followupIdsKey = followupCandidates.map((candidate) => `${candidate.id}:${candidate.rev}`).join(",");
  // 목록에서 사라진 id 는 초안에서 거두고, rev 가 바뀐 id 는 선택을 풀어 새로 고친 본문을 확인한 뒤 다시 고르게 한다.
  useEffect(() => {
    const openRevs = new Map(followupIdsKey ? followupIdsKey.split(",").map((entry) => { const at = entry.lastIndexOf(":"); return [entry.slice(0, at), Number(entry.slice(at + 1))] as const; }) : []);
    pruneSelection(objective.id, openRevs);
  }, [objective.id, followupIdsKey]);
  useEffect(() => { setFollowupOpenId(null); }, [objective.id]);
  const choices: readonly IntentKey[] = primary ? [primary, ...alts] : [];
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<IntentKey | null>(null);
  const [draft, setDraftState] = useState(() => drafts.get(objective.id) ?? "");
  const setDraft = (next: string) => { if (next) drafts.set(objective.id, next); else drafts.delete(objective.id); setDraftState(next); };
  // 보내는 중인 할 일 — 응답이 오기 전에 상태(사다리)가 먼저 바뀌어도 띠는 지금 진행 중인 그 행동을 말한다.
  // 예: 「중단」은 서버가 구상 국면을 먼저 풀어 사다리가 곧바로 「개시」가 되지만, 응답(중단 확인)은 한참 뒤에 온다.
  const [pending, setPending] = useState<IntentKey | null>(null);
  const sending = pending !== null;
  const [error, setError] = useState<string | null>(null);
  // 받는 이 — 목표를 옮기거나 그 세션이 사라지면 지휘관으로 돌아간다.
  const [recipientId, setRecipientId] = useState(objective.id);
  useEffect(() => { setRecipientId(objective.id); }, [objective.id]);
  const recipient = recipients.find((candidate) => candidate.id === recipientId) ?? recipients[0] ?? null;
  const recipientBlocked = recipient?.state === "awaiting";
  const [sentNote, setSentNote] = useState<{ readonly role: string; readonly notified: boolean | null } | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  useEffect(() => { clearTimeout(sentTimer.current); setSentNote(null); }, [objective.id]);
  const bandRef = useRef<HTMLButtonElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const compRef = useRef<HTMLDivElement | null>(null);
  const rows = useLaunchRows();
  const [sheet, setSheet] = useState<RoutingSheet | null>(null);
  // 시트의 판단 응답이 닫은 뒤나 다른 목표에서 늦게 닿으면 버린다.
  const sheetToken = useRef(0);
  const sheetContext = useRef("");
  // 라우팅 확인 시트를 키보드로 열었을 때 첫 ready 안착 대상(이대로 개시 우선)으로 포커스를 옮긴다.
  const sheetFocusPending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => { sheetToken.current += 1; setSheet(null); sheetFocusPending.current = false; clearTimeout(noticeTimer.current); setNotice(null); }, [objective.id]);

  // 컨텍스트 압축 — 두 번 눌러 지휘관과 구성원 모두에게 /compact 를 보낸다. 주행동 보내기와는 서로 잠그지 않는다(이동 칸과 같다).
  const [compactPhase, setCompactPhase] = useState<"idle" | "armed" | "busy" | "done">("idle");
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  const compactTimers = useRef<{ arm?: ReturnType<typeof setTimeout>; done?: ReturnType<typeof setTimeout>; result?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => () => { const timers = compactTimers.current; clearTimeout(timers.arm); clearTimeout(timers.done); clearTimeout(timers.result); }, []);
  const compactSessions = new Set([objective.id, ...objective.members.filter((member) => member.sessionName !== null).map((member) => member.id)]).size;
  const compactExcluded = objective.members.filter((member) => member.sessionName === null).length;
  const compactLocked = compactSessions === 0;
  const disarm = () => {
    clearTimeout(compactTimers.current.arm);
    setCompactPhase((phase) => (phase === "armed" ? "idle" : phase));
  };

  const kinds = (objective.edited?.kinds ?? []).map((kind) => t(EDIT_KEYS[kind]));
  // 사람 아닌 손이 바꾼 보드면 그 이름을 붙인다 — 「임무·기준 · 사령관」.
  const editors = nonHumanEditors(t, objective.edited?.actors);
  const kindText = [kinds.join("·"), ...editors].filter(Boolean).join(" · ");
  const objectiveId = objective.id;
  const members = objective.members.length;
  const proposals = objective.criteriaProposals.length;
  const annotated = objective.criteriaProposals.filter((proposal) => !!proposal.annotation).length;
  const replanDesc = gated ? (annotated ? t("objectives.band.replan.annotated", { count: annotated }) : t("objectives.band.replan.pending")) : t("objectives.band.replan.desc");

  // 라우팅 확인 — 목표마다 스위치(기본 켬). 사람의 개시 경로(개시·재개·유휴 스티어링)만 지나고, 지휘관 도구·후속 목표는 묻지 않는다.
  const routeCount = props.routingTargets.length;
  const confirmOn = objective.routingConfirm;
  const reviewable = (key: IntentKey | null) => (key === "start" || key === "resume" || key === "steerIdle") && routeCount > 0;
  const willReview = (key: IntentKey | null) => reviewable(key) && confirmOn;
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  const ttlMinutes = Math.round(ROUTING_PREVIEW_TTL_MS / 60_000);
  const say = (text: string) => { clearTimeout(noticeTimer.current); setNotice(text); noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS); };
  /** 개시 응답의 failed — 띄우지 못한 구성원을 띠가 잠시 말한다(개시 자체는 이어졌다). */
  const reportFailed = (result: unknown) => {
    const failed = (result as { failed?: readonly { role: string }[] } | undefined)?.failed ?? [];
    if (failed.length) say(t("objectives.start.failedMembers", { count: failed.length, roles: failed.map((entry) => entry.role).join(", ") }));
  };
  const commence = (context: string) => request("/commander/start", { objectiveId, ...(context ? { context } : {}) }).then(reportFailed);
  const startDesc = members ? `${t("objectives.start.members", { count: members })}${routeCount ? t(confirmOn ? "objectives.start.routeConfirm" : "objectives.start.routeDirect", { count: routeCount }) : ""}` : objective.missions.length ? t("objectives.start.direct") : t("objectives.band.start.bare");
  const intents: Record<IntentKey, Intent> = {
    extend: { word: t("objectives.extend.action"), desc: t(objective.done ? "objectives.extend.doneDesc" : "objectives.extend.reviewDesc"), talk: true, glyph: <WandGlyph />, placeholder: t("objectives.extend.placeholder"), run: (context) => request("/objective/extend", { objectiveId, context }) },
    plan: { word: t("objectives.band.plan"), desc: t("objectives.band.plan.desc"), talk: true, glyph: <WandGlyph />, placeholder: t("objectives.commander.planContext"), run: (context) => request("/plan/request", { objectiveId, context }) },
    replan: { word: t("objectives.band.replan"), desc: replanDesc, talk: true, glyph: <WandGlyph />, placeholder: t("objectives.band.replan.ph"), run: (context) => request("/plan/request", { objectiveId, context }) },
    start: { word: t("objectives.commander.start"), desc: startDesc, talk: true, glyph: <StartGlyph />, placeholder: t("objectives.band.start.ph"), run: commence },
    resume: { word: t("objectives.commander.start"), desc: `${props.commanderState} · ${t("objectives.start.resume")}`, talk: true, glyph: <StartGlyph />, placeholder: t("objectives.band.resume.ph"), run: commence },
    steer: {
      word: t("objectives.steer"),
      desc: objective.planning && !props.working ? t("objectives.band.steer.planning", { kinds: kindText }) : `${t("objectives.band.steer.desc", { kinds: kindText })}${objective.awaitingReview ? t("objectives.band.steer.review") : ""}`,
      talk: true, glyph: <SteerGlyph />, placeholder: t("objectives.band.steer.ph"),
      run: (context) => request("/commander/steer", { objectiveId, ...(context ? { context } : {}) }),
    },
    steerIdle: { word: t("objectives.steer"), desc: t("objectives.band.steerIdle.desc", { kinds: kindText }), talk: true, glyph: <SteerGlyph />, placeholder: t("objectives.band.steer.ph"), run: commence },
    complete: { word: t("objectives.review.complete"), desc: t(objective.criteria.length > 0 ? "objectives.review.subCriteria" : "objectives.review.sub"), talk: false, tone: "aurora", run: () => request("/objective/complete", { objectiveId }) },
    handOff: { word: t("objectives.handoff.send"), desc: t("objectives.handoff.sendDesc"), talk: false, glyph: <HandOffGlyph />, run: () => request("/objective/hand-off", { objectiveId }) },
    decide: { word: t("objectives.awaiting.word"), desc: t("objectives.awaiting.commander"), talk: false, tone: "aurora", glyph: <DecideDot />, run: async () => props.onFocusOperation(objectiveId) },
    decideMember: {
      word: t("objectives.awaiting.word"),
      desc: props.memberAwaiting?.mission ? t("objectives.band.decideMemberMission", { role: props.memberAwaiting.role, index: props.memberAwaiting.mission }) : t("objectives.band.decideMember", { role: props.memberAwaiting?.role ?? "" }),
      talk: false, tone: "aurora", glyph: <DecideDot />,
      run: async () => { if (props.memberAwaiting) props.onFocusOperation(props.memberAwaiting.operationId); },
    },
    stop: { word: t("objectives.stop"), desc: objective.planning && props.busy ? t("objectives.band.stopPlanning") : t("objectives.stopHint"), talk: false, tone: "stop", glyph: <StopGlyph />, run: () => request("/commander/stop", { objectiveId }) },
    message: {
      word: t("objectives.message"), desc: t("objectives.band.message.desc"), talk: true, glyph: <MessageGlyph />,
      placeholder: t("objectives.band.message.ph", { role: recipient?.role ?? "" }),
      run: async (text) => {
        if (!recipient) return;
        const result = await request("/commander/message", { objectiveId, memberId: recipient.id === objectiveId ? null : recipient.id, text }) as { notified?: boolean | null } | undefined;
        clearTimeout(sentTimer.current);
        setSentNote({ role: recipient.role, notified: result?.notified ?? null });
        sentTimer.current = setTimeout(() => setSentNote(null), SENT_NOTE_MS);
      },
    },
  };

  // 펼친 사이 상태가 바뀌어 고른 할 일이 사라지면 — 주행동이 말 거는 행동이면 그리로 옮기고, 아니면 접는다(초안은 남는다).
  useEffect(() => {
    if (pending || !open || !intent || choices.includes(intent)) return;
    if (primary && intents[primary].talk) setIntent(primary);
    else setOpen(false);
  });
  // 띠 상태나 목표가 바뀌면, 접고 펼치면 무장을 푼다.
  useEffect(() => { disarm(); }, [objective.id, primary, open, followupOpen]);
  // 초안이 늘면 칸도 는다 — 최대 132px 뒤로는 안에서 스크롤.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  }, [draft, open, intent]);

  // 라우팅 확인 시트 포커스 — 키보드로 시트를 연 첫 ready 때 첫 대상(이대로 개시 우선)으로 옮긴다.
  // judging 중에는 BODY로 떨어지지 않게 시트 컨테이너에 머물게 하고, 이미 다른 곳으로 옮겼거나 재판단 시에는 빼앗지 않는다.
  useEffect(() => {
    if (!sheet) return;
    const container = compRef.current;
    if (!container) return;
    if (sheet.phase === "judging") {
      const active = document.activeElement;
      if (!active || active === document.body || !container.contains(active)) {
        container.focus();
      }
      return;
    }
    if (sheet.phase === "ready" && sheetFocusPending.current) {
      sheetFocusPending.current = false;
      const active = document.activeElement;
      // 판단 중에 사용자가 시트 안이든 밖이든 다른 곳으로 옮겼으면 그 선택을 지킨다 — BODY나 시트 컨테이너에 있을 때만 옮긴다.
      if (active && active !== document.body && active !== container) return;
      const goBtn = container.querySelector<HTMLButtonElement>("button.objectives-comp-send");
      if (goBtn && !goBtn.disabled && goBtn.getAttribute("aria-disabled") !== "true") {
        goBtn.focus();
        return;
      }
      const rowTrigger = container.querySelector<HTMLButtonElement>(".objectives-routing-list button:not([disabled])");
      if (rowTrigger && rowTrigger.getAttribute("aria-disabled") !== "true") {
        rowTrigger.focus();
        return;
      }
      const rejudgeBtn = container.querySelector<HTMLButtonElement>(".objectives-routing-foot button:not([disabled])");
      if (rejudgeBtn && rejudgeBtn.getAttribute("aria-disabled") !== "true") {
        rejudgeBtn.focus();
        return;
      }
      const anyBtn = container.querySelector<HTMLButtonElement>("button:not([disabled])");
      if (anyBtn && anyBtn.getAttribute("aria-disabled") !== "true") {
        anyBtn.focus();
        return;
      }
      container.focus();
    }
  }, [sheet?.phase]);

  if (!primary && !pending) return null;
  const current = open && intent ? intents[intent] : null;
  const unavailable = (key: IntentKey) => intents[key].talk && !props.launchAvailable;

  const pick = (key: IntentKey, focus: "field" | "radio") => {
    disarm();
    setIntent(key);
    setError(null);
    // 구상의 맥락은 목표에 남아 있다 — 칸이 비었으면 지난번 말로 미리 채운다.
    if ((key === "plan" || key === "replan") && !draft && objective.planRequest) setDraft(objective.planRequest);
    requestAnimationFrame(() => {
      if (focus === "field" && intents[key].talk) { const field = fieldRef.current; if (field && !field.disabled) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); } }
      else compRef.current?.querySelector<HTMLElement>(`[data-intent="${key}"]`)?.focus();
    });
  };
  const fold = (focusBand: boolean) => {
    setOpen(false);
    setError(null);
    setFollowupOpen(objective.id, false);
    if (focusBand) requestAnimationFrame(() => bandRef.current?.focus());
  };
  const run = async (key: IntentKey) => {
    const chosen = intents[key];
    if (sending || unavailable(key)) return;
    // 메시지는 말이 곧 내용이다 — 빈 칸은 보내지 않고 칸으로 돌아간다. 허용 대기 중인 받는 이는 호스트가 거절하므로 잠근다.
    if ((key === "extend" && !draft.trim()) || (key === "message" && (!draft.trim() || !recipient || recipientBlocked))) { fieldRef.current?.focus(); return; }
    // 확인을 켰으면 개시가 판단 → 확인 → 기동으로 나뉜다 — 여기서는 판단만 하고 시트를 연다.
    if (willReview(key)) {
      sheetContext.current = draft.trim();
      setError(null);
      setOpen(false);
      sheetFocusPending.current = true;
      loadPreview(false);
      return;
    }
    setPending(key);
    setError(null);
    try {
      await chosen.run(chosen.talk ? draft.trim() : "");
      if (chosen.talk) setDraft("");
      setOpen(false);
      requestAnimationFrame(() => bandRef.current?.focus());
    } catch (failure) {
      setError(bandFailure(t, failure, { message: key === "message", talk: chosen.talk }));
    } finally {
      setPending(null);
    }
  };
  /** 후속 묶음 완료 — 선택 순간의 rev 로 한 번만 보낸다. 바뀌었으면 서버가 followup_changed 로 거절한다. 고른 게 없으면 지금 완료 그대로다. */
  const runFollowups = async () => {
    if (sending) return;
    const stored = readSelectionRevs(objective.id);
    const live = new Set(openFollowups(objective).map((candidate) => candidate.id));
    const picked = [...stored].filter(([id]) => live.has(id));
    setPending("complete");
    setError(null);
    try {
      if (picked.length === 0) await intents.complete.run("");
      else await request("/objective/complete", { objectiveId, batchId: newBatchId(), followups: picked.map(([id, rev]) => ({ id, rev })) });
      clearSelection(objectiveId);
      setFollowupOpen(objective.id, false);
      setFollowupOpenId(null);
      requestAnimationFrame(() => bandRef.current?.focus());
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "unknown";
      const reason = REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code });
      setError(t("objectives.band.failedAction", { reason }));
    } finally {
      setPending(null);
    }
  };
  const discardFollowup = (candidateId: string) => {
    void request("/followup/discard", { objectiveId, candidateId }).catch((failure: unknown) => {
      const code = failure instanceof Error ? failure.message : "unknown";
      const reason = REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code });
      setError(t("objectives.band.failedAction", { reason }));
    });
  };
  /** 판단(또는 캐시) — rejudge 면 다시 판단한다. 결과를 이미 보고 있으면 그대로 두고 갱신만 한다(refreshing). */
  const loadPreview = (rejudge: boolean) => {
    const token = ++sheetToken.current;
    setSheet((current) => ({ phase: current?.preview && !rejudge ? "refreshing" : "judging", preview: current?.preview ?? null, known: rejudge ? new Map() : current?.known ?? new Map(), overridden: current?.overridden ?? new Map(), error: null }));
    void request("/routing/preview", { objectiveId, ...(rejudge ? { rejudge: true } : {}) }).then((result) => {
      if (token !== sheetToken.current) return;
      const preview = (result as { preview?: RoutingPreview } | undefined)?.preview ?? null;
      // 직접 지정으로 대상에서 빠진 구성원의 앞선 결과도 남긴다 — 「라우팅 결과 쓰기」가 무엇으로 돌아가는지 계속 말한다.
      setSheet((current) => current && { ...current, phase: "ready", preview, known: new Map([...current.known, ...(preview?.members ?? []).map((entry) => [entry.id, entry] as const)]) });
    }, (failure: unknown) => {
      if (token !== sheetToken.current) return;
      const code = failure instanceof Error ? failure.message : "unknown";
      setSheet((current) => current && { ...current, phase: "ready", error: code });
    });
  };
  const closeSheet = () => {
    sheetToken.current += 1;
    sheetFocusPending.current = false;
    if (sheet?.preview) say(t("objectives.routing.kept", { minutes: ttlMinutes }));
    setSheet(null);
    setOpen(false);
    requestAnimationFrame(() => bandRef.current?.focus());
  };
  /** 시트의 직접 지정 — 구성원 선택을 바꾸고(라우팅으로 되돌리기 포함) 결과를 다시 읽는다. 함께 판단한 구성원이면 새 판단은 없다. */
  const pickInSheet = (member: ObjectiveMember, launch: { mode: "model"; model: string; effort?: string } | null) => {
    if (!sheet) return;
    const previous = sheet.overridden.get(member.id);
    const overridden = new Map(sheet.overridden);
    if (launch) overridden.set(member.id, launch); else overridden.delete(member.id);
    setSheet({ ...sheet, overridden });
    void request("/member/patch", { objectiveId, memberId: member.id, patch: { launch } }).then(() => loadPreview(false), (failure: unknown) => {
      const code = failure instanceof Error ? failure.message : "unknown";
      // 저장되지 않은 선택을 행에 남기지 않는다 — 「이대로 개시」는 저장된 설정으로 띄우므로 행도 지정 전 값으로 돌아간다.
      setSheet((current) => {
        if (!current) return current;
        const restored = new Map(current.overridden);
        if (previous) restored.set(member.id, previous); else restored.delete(member.id);
        return { ...current, overridden: restored, error: code };
      });
    });
  };
  /** 「이대로 개시」 — 본 결과 그대로 띄운다. 그새 결과를 쓸 수 없게 됐으면 다시 읽어 보여 준다(바뀐 대상만 판단). */
  const goSheet = async () => {
    if (sending || !sheet || sheet.phase !== "ready") return;
    setPending(intent ?? "start");
    try {
      const context = sheetContext.current;
      reportFailed(await request("/commander/start", { objectiveId, routing: "preview", ...(context ? { context } : {}) }));
      sheetToken.current += 1;
      sheetFocusPending.current = false;
      setDraft("");
      setSheet(null);
      setOpen(false);
      requestAnimationFrame(() => bandRef.current?.focus());
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "unknown";
      if (code === "routing_preview_stale") { loadPreview(false); setSheet((current) => current && { ...current, error: code }); }
      else setSheet((current) => current && { ...current, error: code });
    } finally {
      setPending(null);
    }
  };
  const press = () => {
    // 보내는 중에는 버튼이 aria-disabled로 포커스만 지킨다 — 클릭·Enter·Space가 여기로 오므로 입구에서 거른다.
    if (sending) return;
    disarm();
    if (!primary) return;
    // 후보가 있으면 완료하지 않고 펼친다 — 한 번 누름으로 후보 검토를 건너뛰는 길을 없앤다.
    if (primary === "complete" && followupAvailable) {
      setFollowupOpenId(null);
      setFollowupOpen(objective.id, true);
      setError(null);
      requestAnimationFrame(() => { compRef.current?.querySelector<HTMLElement>("[data-followup-sel]")?.focus(); });
      return;
    }
    const main = intents[primary];
    if (main.talk || alts.length > 0) { setOpen(true); pick(primary, "field"); return; }
    void run(primary);
  };
  const onRadioKey = (event: ReactKeyboardEvent<HTMLButtonElement>, key: IntentKey) => {
    const mission = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!mission) return;
    event.preventDefault();
    const next = choices[(choices.indexOf(key) + mission + choices.length) % choices.length]!;
    pick(next, "radio");
  };
  const onRecipientKey = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = recipients.findIndex((candidate) => candidate.id === id);
    const next = recipients[(index + step + recipients.length) % recipients.length]!;
    setRecipientId(next.id);
    setError(null);
    requestAnimationFrame(() => compRef.current?.querySelector<HTMLElement>(`[data-recipient="${next.id}"]`)?.focus());
  };
  /** 받는 이 상태로 본 도착 방식 — 구성원이면 지휘관에게도 알린다는 말이 붙는다. */
  const messageHow = (target: MessageRecipient): string => `${t(HOW_KEYS[target.state] ?? "objectives.band.message.how.idle")}${target.id !== objectiveId && target.state !== "awaiting" ? t("objectives.band.message.alsoCommander") : ""}`;
  const onCompKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Esc 는 칸만 접는다 — 상세를 닫는 창 처리기로 올라가지 않게 막는다. 두 번째 Esc 가 상세를 닫는다.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); fold(true); }
  };
  const fireCompact = async () => {
    setCompactPhase("busy");
    setError(null);
    try {
      const result = (await request("/commander/compact", { objectiveId })) as Partial<CompactResult> | undefined;
      const counts: CompactResult = { requested: result?.requested ?? 0, woken: result?.woken ?? 0, rejected: result?.rejected ?? 0, excluded: result?.excluded ?? 0 };
      if (counts.requested === 0) {
        setCompactPhase("idle");
        setError(t("objectives.band.failedAction", { reason: t("objectives.compact.none") }));
        return;
      }
      setCompactPhase("done");
      setCompactResult(counts);
      const timers = compactTimers.current;
      clearTimeout(timers.done); clearTimeout(timers.result);
      timers.done = setTimeout(() => setCompactPhase((phase) => (phase === "done" ? "idle" : phase)), COMPACT_DONE_MS);
      timers.result = setTimeout(() => setCompactResult(null), COMPACT_RESULT_MS);
    } catch (failure) {
      setCompactPhase("idle");
      const code = failure instanceof Error ? failure.message : "unknown";
      const reason = REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code });
      setError(t("objectives.band.failedAction", { reason }));
    }
  };
  const pressCompact = () => {
    if (compactLocked || compactPhase === "busy") return;
    if (compactPhase === "armed") { clearTimeout(compactTimers.current.arm); void fireCompact(); return; }
    setCompactResult(null);
    setCompactPhase("armed");
    clearTimeout(compactTimers.current.arm);
    compactTimers.current.arm = setTimeout(disarm, COMPACT_ARM_MS);
  };
  const onCompactKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // 누르고 있는 키의 반복으로는 확정하지 않는다.
    if ((event.key === "Enter" || event.key === " ") && event.repeat) { event.preventDefault(); return; }
    // 무장 중의 첫 Esc 는 무장만 푼다 — 칸을 접는 것은 다음 Esc 다.
    if (event.key === "Escape" && compactPhase === "armed") { event.preventDefault(); event.stopPropagation(); disarm(); }
  };
  /** 무장 중이면 확정 안내, 결과가 있으면 결과 — 그 밖엔 null 이라 원래 설명이 선다. */
  const compactNote: ReactNode = compactPhase === "armed" ? (
    <span className="objectives-compact-note" aria-live="polite"><b>{t("objectives.compact.arm", { count: compactSessions })}</b>{compactExcluded ? t("objectives.compact.armExcluded", { count: compactExcluded }) : null}</span>
  ) : compactResult ? (
    <span className="objectives-compact-note" aria-live="polite">
      {([["requested", compactResult.requested], ["woken", compactResult.woken], ["rejected", compactResult.rejected], ["excluded", compactResult.excluded]] as const)
        .filter(([, count]) => count > 0)
        .map(([key, count], index) => { const text = t(`objectives.compact.${key}`, { count }); return index === 0 ? <b key={key}>{text}</b> : <span key={key}> · {text}</span>; })}
    </span>
  ) : null;
  const compactButton = (className: string) => {
    const label = compactLocked ? t("objectives.compact.empty") : compactPhase === "armed" ? t("objectives.compact.armAria") : t("objectives.compact.label");
    const inert = compactLocked || compactPhase === "busy";
    return (
      <button
        type="button"
        className={`${className}${compactPhase === "armed" ? " is-armed" : ""}${compactPhase === "done" ? " is-done" : ""}${compactLocked ? " is-locked" : ""}`}
        aria-label={label}
        title={compactLocked ? t("objectives.compact.empty") : t("objectives.compact.label")}
        aria-disabled={inert || undefined}
        aria-busy={compactPhase === "busy" || undefined}
        onClick={pressCompact}
        onKeyDown={onCompactKey}
        onBlur={disarm}
      >
        {compactPhase === "done" ? <CheckGlyph /> : <CompactGlyph />}
      </button>
    );
  };
  /** 방금 보낸 메시지의 흔적 — 접힌 띠 부제에 잠시 선다. 구성원에게 보냈으면 지휘관 통지가 닿았는지도 함께 말한다. */
  const sentLine: ReactNode = sentNote ? (
    <span className="objectives-compact-note" role="status"><b>{t("objectives.message.sent", { role: sentNote.role })}</b>{sentNote.notified === true ? t("objectives.message.notified") : sentNote.notified === false ? t("objectives.message.notNotified") : null}</span>
  ) : null;
  const noticeLine: ReactNode = notice ? <span className="objectives-compact-note" role="status"><b>{notice}</b></span> : null;
  const bandNote: ReactNode = compactNote ?? sentLine ?? noticeLine;
  /** 보내는 동안의 부제 — 중단은 「중단하는 중…」, 나머지는 「보내는 중…」. */
  const pendingText = (key: IntentKey) => t(key === "stop" ? "objectives.band.stopping" : "objectives.band.sending");
  const word = (entry: Intent) => <span className="objectives-start-word">{entry.tone ? entry.glyph : null}{entry.word}</span>;
  const errorLine = error ? <div className="objectives-band-error" role="alert">{error}</div> : null;
  // 잠긴 개시 — 누를 수 없는 한 줄. 편집 뒤면 낱말은 「스티어링」이다. 결정은 위의 기준 줄에서 한다.
  const lockedLine = gated ? (
    <div className="objectives-start is-locked" role="note">
      <span className="objectives-start-word"><LockGlyph />{t(objective.commander.started && (objective.edited?.kinds.length ?? 0) > 0 ? "objectives.steer" : "objectives.commander.start")}</span>
      <span className="objectives-start-sub">{t("objectives.band.gated", { count: proposals })}</span>
      <span className="objectives-start-arrow" aria-hidden="true">→</span>
    </div>
  ) : null;

  // 후속 comp — 띠가 위로 자라 후보를 읽고 고른 뒤 같은 자리에서 완료한다. Esc 는 칸만 접는다.
  // 접힌 띠 분기보다 먼저 온다: 후보 칸은 open/intent 를 쓰지 않아 current 가 항상 null 이라, 뒤에 두면 절대 그려지지 않는다.
  if (followupOpen && followupAvailable) {
    const picked = followupCandidates.filter((candidate) => followupSelection.has(candidate.id)).length;
    const total = followupCandidates.length;
    const sendSub = picked === 0 ? t("objectives.followup.sendEmpty", { n: total }) : t("objectives.followup.sendSome", { k: picked });
    const complete = intents.complete;
    return (
      <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
        {lockedLine}
        <div ref={compRef} className="objectives-comp is-review" role="group" aria-label={t("objectives.followup.pick")} onKeyDown={onCompKey} data-followup-comp={objective.id}>
          <div className="objectives-comp-top">
            {compactNote ?? <span>{t("objectives.followup.pick")} · <span className="objectives-followup-count" aria-live="polite">{t("objectives.followup.count", { k: picked, n: total })}</span></span>}
            <span className="objectives-comp-tools">
              <button type="button" className="objectives-btn is-small" disabled={sending || unavailable("extend")} onClick={() => { setFollowupOpen(objective.id, false); setOpen(true); pick("extend", "field"); }}>{intents.extend.word}</button>
              {props.commanderExists ? compactButton("objectives-glyph objectives-comp-compact") : null}
              {props.commanderExists ? <button type="button" className="objectives-glyph objectives-comp-goto" aria-label={t("objectives.objective.goToOperation")} title={t("objectives.objective.goToOperation")} onClick={() => props.onFocusOperation(objective.id)}><GoGlyph /></button> : null}
              <button type="button" className="objectives-glyph objectives-comp-fold" aria-label={t("objectives.band.fold")} title={t("objectives.band.fold")} onClick={() => fold(true)}><CloseGlyph /></button>
            </span>
          </div>
          <div className="objectives-followup-comp-list">
            <FollowupCandidateList
              candidates={followupCandidates}
              selectable
              selection={followupSelection}
              t={t}
              idPrefix={`band-${objective.id}`}
              openId={followupOpenId}
              onOpenChange={setFollowupOpenId}
              onToggleCheck={(candidateId, checked) => { const rev = followupCandidates.find((candidate) => candidate.id === candidateId)?.rev ?? 1; toggleFollowupSelection(objective.id, candidateId, checked, rev); setError(null); }}
              onDiscard={discardFollowup}
            />
          </div>
          <FollowupDiscardedTrace discarded={discardedFollowups(objective)} t={t} />
          {errorLine}
          <button
            type="button"
            className="objectives-start objectives-comp-send is-review"
            // 보내는 중은 aria-disabled로만 막는다(runFollowups가 sending을 다시 거른다) — native disabled는 막 누른 버튼의 포커스를 문서로 떨군다.
            aria-disabled={sending || undefined}
            aria-busy={sending || undefined}
            onClick={() => void runFollowups()}
          >
            {word(complete)}
            <span className="objectives-start-sub">{pending ? pendingText(pending) : sendSub}</span>
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    );
  }

  if (sheet) {
    const judging = sheet.phase === "judging";
    const settling = sheet.phase !== "ready";
    // 판단 중일 때만 행 메뉴를 잠근다 — 직접 지정 뒤의 갱신(refreshing)이 메뉴를 닫으면 강도 단계로 이어지지 못한다.
    const rowLocked = judging || sending;
    const results = sheet.known;
    const commanderWords = launchedWords(rows, objective.commander.model, objective.commander.effort, labels);
    const wide = (sheet.preview?.members ?? []).flatMap((entry) => (entry.via === "fallback" && SET_WIDE_REASONS.has(entry.reason) ? [entry.reason] : []))[0];
    const minutes = sheet.preview ? Math.floor((Date.now() - sheet.preview.at) / 60_000) : 0;
    const status = judging ? t("objectives.routing.judging") : !sheet.preview ? "" : sheet.preview.judged ? t("objectives.routing.judgedNow") : minutes <= 0 ? t("objectives.routing.cachedNow") : t("objectives.routing.cached", { minutes });
    const words = (model: string | undefined, effort: string | undefined) => { const shown = launchedWords(rows, model, effort, labels); return <span className="objectives-routing-words" title={shown.title}><LaunchedText model={shown.model} words={shown.words} /></span>; };
    const reasonText = (code: string) => (REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code }));
    const memberRow = (member: ObjectiveMember) => {
      const result = results.get(member.id);
      const target = props.routingTargets.some((candidate) => candidate.id === member.id);
      const picked = sheet.overridden.get(member.id);
      const row = (label: string, pick: ReactNode, why?: { readonly text: string; readonly warn?: boolean }, fixed = false) => (
        <div key={member.id} className={`objectives-routing-row${fixed ? " is-fixed" : ""}`}>
          {props.memberMark(member.id)}
          <span className="objectives-routing-who"><span className="objectives-routing-role">{member.role}</span><small>{label}</small></span>
          <span className="objectives-routing-pick">{pick}</span>
          {why ? <span className={`objectives-routing-why${why.warn ? " is-warn" : ""}`}>{why.text}</span> : null}
        </div>
      );
      // 예약이 걸린 구성원은 예약값으로 재개를 시도한다 — 시트도 그 모델을 보인다.
      if (props.memberLaunched(member)) return member.next && !member.next.failed
        ? row(t("objectives.routing.fixedReserved"), words(member.next.model, member.next.effort), undefined, true)
        : row(t("objectives.routing.fixedResume"), words(member.model, member.effort), undefined, true);
      // 폴백은 띄우는 순간의 지휘관 프리셋으로 뜬다 — 시트를 연 사이 프리셋을 바꿔도 보이는 모델이 실제 기동과 같게 지금 값을 보인다.
      const shownModel = result?.via === "fallback" ? objective.commander : result;
      const resultWords = result ? `${launchedWords(rows, shownModel?.model, shownModel?.effort, labels).title}${result.via === "fallback" ? ` · ${t("objectives.members.fallback")}` : ""}` : t("objectives.routing.atLaunch");
      const useResult = { id: "route", label: t("objectives.routing.useResult"), hint: resultWords };
      const onModel = (next: { model?: string; effort?: string }) => { if (next.model) pickInSheet(member, { mode: "model", model: next.model, ...(next.effort ? { effort: next.effort } : {}) }); };
      if (picked) {
        return row(t("objectives.routing.viaPicked"), <LaunchControl t={t} model={picked.model} effort={picked.effort} locked={rowLocked} startAtList triggerLabel={t("objectives.routing.rowAria", { role: member.role })}
          extras={[{ ...useResult, active: false, onPick: () => pickInSheet(member, null) }]} onChange={onModel} />, { text: t("objectives.routing.picked") });
      }
      if (target) {
        const trigger = judging && !result ? <span className="objectives-routing-judging"><Spinner />{t("objectives.routing.judgingRow")}</span>
          : result ? <>{words(shownModel?.model, shownModel?.effort)}{result.via === "fallback" ? <span className="objectives-member-via is-fallback">{t("objectives.members.fallback")}</span> : null}</>
          : <span className="objectives-launch-model">{t("objectives.routing.atLaunch")}</span>;
        const why = !result || judging ? undefined : result.via === "route" ? (result.because ? { text: result.because } : undefined) : { text: t("objectives.routing.fallbackWhy", { reason: routingReason(t, result.reason) }), warn: true };
        return row(t("objectives.routing.viaRoute"), <LaunchControl t={t} model={undefined} effort={undefined} locked={rowLocked} startAtList triggerLabel={t("objectives.routing.rowAria", { role: member.role })} triggerText={trigger}
          extras={[{ ...useResult, active: true, onPick: () => undefined }]} onChange={onModel} />, why);
      }
      if (member.launch.mode === "model") return row(t("objectives.routing.fixedModel"), words(member.launch.model, member.launch.effort), undefined, true);
      return row(t("objectives.memberSelection.inherit"), words(objective.commander.model, objective.commander.effort), undefined, true);
    };
    return (
      <div className="objectives-group objectives-start-group">
        <div ref={compRef} className="objectives-comp objectives-routing" role="dialog" aria-label={t("objectives.routing.title")} aria-busy={judging || undefined} tabIndex={-1}
          onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeSheet(); } }}>
          <div className="objectives-comp-top">
            <span className="objectives-routing-head"><b>{t("objectives.routing.title")}</b><span aria-live="polite">{judging ? <><Spinner />{status}</> : status}</span></span>
            <span className="objectives-comp-tools">
              <button type="button" className="objectives-glyph objectives-comp-fold" aria-label={t("objectives.routing.close")} title={t("objectives.routing.close")} onClick={closeSheet}><CloseGlyph /></button>
            </span>
          </div>
          {wide && !judging ? <div className="objectives-routing-banner" role="note">{wide === "routing_disabled" ? t("objectives.routing.banner.disabled", { model: `${commanderWords.words.model} · ${commanderWords.words.effort}` }) : t("objectives.routing.banner.other", { reason: routingReason(t, wide), model: `${commanderWords.words.model} · ${commanderWords.words.effort}` })}</div> : null}
          <div className="objectives-routing-list">{objective.members.map(memberRow)}</div>
          {sheet.error ? <div className="objectives-band-error" role="alert">{sheet.error === "routing_preview_stale" ? reasonText(sheet.error) : t("objectives.routing.failed", { reason: reasonText(sheet.error) })}</div> : null}
          <div className="objectives-routing-foot">
            <span>{routeCount ? t("objectives.routing.foot", { count: routeCount, minutes: ttlMinutes }) : t("objectives.routing.footNone")}</span>
            {/* 재판단 대기·보내는 중은 일시 상태라 aria-disabled로 막는다(onClick이 거른다) — 키보드로 막 누른 「다시 판단」의 포커스를 지킨다. */}
            <button type="button" className="objectives-btn is-small" disabled={routeCount === 0} aria-disabled={settling || sending || undefined} aria-busy={settling || undefined} onClick={() => { if (settling || sending || routeCount === 0) return; loadPreview(true); }}>{t("objectives.routing.rejudge")}</button>
          </div>
          {/* 판단 대기(settling)·보내는 중은 모두 저절로 끝나는 일시 상태라 aria-disabled로만 막는다(goSheet가 둘 다 거른다).
              결과가 낡아 거절되면 goSheet가 곧바로 다시 읽어(refreshing) — native disabled면 막 누른 이 버튼의 포커스가 실패 직후 문서로 빠진다. */}
          <button type="button" className="objectives-start objectives-comp-send" aria-disabled={settling || sending || undefined} aria-busy={sending || undefined} onClick={() => void goSheet()}>
            <span className="objectives-start-word">{t("objectives.routing.go")}</span>
            <span className="objectives-start-sub">{pending ? pendingText(pending) : <>{sheetContext.current ? <b className="objectives-band-draft">{t("objectives.band.draft")}</b> : null}{intents[intent ?? "start"].desc}</>}</span>
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    );
  }

  if (!current || !intent) {
    // 보내는 동안은 진행 중인 그 행동을 보이고(다른 선택은 감춘다), 잠근다. 응답이 오면 사다리로 돌아간다.
    // 이동 칸은 보내기와 무관하므로 잠그지 않는다 — 보내는 중에도 ↗ 는 누를 수 있다.
    const shown = pending ?? primary!;
    const main = intents[shown];
    const others = pending ? [] : alts;
    const followupExpands = !pending && followupAvailable;
    const opens = !pending && (main.talk || others.length > 0 || followupExpands);
    const hasDraft = !pending && main.talk && !!draft.trim();
    // 결정 대기(decide·decideMember)는 띠 자체가 이동이다 — 분할 칸 없이 끝의 → 자리에 이동 글리프가 선다.
    const decide = shown === "decide" || shown === "decideMember";
    const toneCls = main.tone ? ` is-${main.tone === "stop" ? "stop" : shown === "complete" ? "review" : "awaiting"}` : "";
    const goLabel = t("objectives.objective.goToOperation");
    const bandCls = `objectives-band${others.length || followupExpands ? " has-alt" : ""}${main.tone === "stop" ? " is-stop" : ""}${followupExpands ? " is-review" : ""}`;
    const mainButton = (
      <button
        ref={bandRef}
        type="button"
        className={`objectives-start${gated ? " is-secondary" : ""}${toneCls}${shown === "steer" || shown === "steerIdle" ? " is-steer" : ""}`}
        // 영구 사용 불가만 native disabled다. 보내는 중은 aria-disabled로 막는다(press·run이 sending을 거른다) — 키보드로 막 누른 「중단」의 포커스를 지킨다.
        disabled={unavailable(shown)}
        aria-disabled={sending || undefined}
        aria-busy={sending || undefined}
        title={unavailable(shown) ? t("objectives.commander.unavailable") : opens ? t("objectives.band.opens") : undefined}
        aria-expanded={opens ? false : undefined}
        aria-label={decide ? `${main.word} — ${goLabel}` : undefined}
        onClick={press}
      >
        {word(main)}
        <span className="objectives-start-sub">
          {hasDraft ? <b className="objectives-band-draft">{t("objectives.band.draft")}</b> : null}
          {!decide && bandNote ? <span className="objectives-start-desc">{bandNote}</span> : <span className="objectives-start-desc">{pending ? pendingText(pending) : followupExpands ? t("objectives.followup.sub", { n: followupCandidates.length }) : main.desc}</span>}
          {/* 다른 할 일로 가는 길은 말줄임 대상이 아니다 — 좁은 레일에서 설명이 먼저 줄고 「…도 여기서」는 끝까지 남는다. */}
          {others.length ? <span className="objectives-band-also"> · {t("objectives.band.also", { words: others.map((key) => `「${intents[key].word}」`).join("") })}</span> : null}
        </span>
        {decide ? <span className="objectives-start-arrow" aria-hidden="true"><GoGlyph /></span> : null}
      </button>
    );
    // A 분할 칸 — 주행동과 이동이 띠 하나에 나란히 선다. 끝의 → 칸은 이동 칸으로 바뀐다.
    if (!decide) {
      return (
        <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
          {lockedLine}
          <div className={bandCls}>
            {props.commanderExists ? <div className={`objectives-split has-compact${toneCls}`}>
              {mainButton}
              <div className="objectives-split-tools">
                {compactButton("objectives-split-goto objectives-split-compact")}
                <button type="button" className="objectives-split-goto" aria-label={goLabel} title={goLabel} onClick={() => { disarm(); props.onFocusOperation(objective.id); }}><GoGlyph /></button>
              </div>
            </div> : mainButton}
          </div>
          {errorLine}
        </div>
      );
    }
    return (
      <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
        {lockedLine}
        <div className={bandCls}>
          {mainButton}
        </div>
        {errorLine}
      </div>
    );
  }

  const many = choices.length > 1;
  return (
    <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
      {lockedLine}
      <div ref={compRef} className={`objectives-comp${current.tone === "stop" ? " is-stop" : ""}`} role="group" aria-label={t("objectives.band.send")} onKeyDown={onCompKey}>
        <div className="objectives-comp-top">
          {compactNote ?? <span>{t(many ? "objectives.band.choose" : "objectives.band.send")}</span>}
          <span className="objectives-comp-tools">
            {props.commanderExists ? compactButton("objectives-glyph objectives-comp-compact") : null}
            {props.commanderExists ? <button type="button" className="objectives-glyph objectives-comp-goto" aria-label={t("objectives.objective.goToOperation")} title={t("objectives.objective.goToOperation")} onClick={() => props.onFocusOperation(objective.id)}><GoGlyph /></button> : null}
            <button type="button" className="objectives-glyph objectives-comp-fold" aria-label={t("objectives.band.fold")} title={t("objectives.band.fold")} onClick={() => fold(true)}><CloseGlyph /></button>
          </span>
        </div>
        {many ? (
          <div className="objectives-intents" role="radiogroup" aria-label={t("objectives.band.intents")}>
            {choices.map((key) => {
              const entry = intents[key];
              const selected = key === intent;
              return (
                <button key={key} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-intent={key} disabled={sending} className={`objectives-intent${entry.tone === "stop" ? " is-stop" : ""}`} onClick={() => pick(key, "field")} onKeyDown={(event) => onRadioKey(event, key)}>
                  <span className="objectives-intent-datum" aria-hidden="true" />
                  <span className="objectives-intent-glyph" aria-hidden="true">{entry.glyph}</span>
                  <span className="objectives-intent-word">{entry.word}</span>
                  <span className="objectives-intent-desc">{entry.desc}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {intent === "message" && recipient ? (
          <div className="objectives-recips" role="radiogroup" aria-label={t("objectives.band.message.recipients")}>
            {recipients.map((candidate) => {
              const selected = candidate.id === recipient.id;
              return (
                <button key={candidate.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} disabled={sending} data-recipient={candidate.id} className="objectives-recip"
                  onClick={() => { setRecipientId(candidate.id); setError(null); requestAnimationFrame(() => fieldRef.current?.focus()); }}
                  onKeyDown={(event) => onRecipientKey(event, candidate.id)}>
                  {candidate.mark}
                  <span className="objectives-recip-role">{candidate.role}</span>
                  <span className={`objectives-recip-state is-${candidate.state}${candidate.outcome === "failed" && candidate.state !== "running" && candidate.state !== "background" && candidate.state !== "awaiting" ? " is-failed" : ""}`}>{props.stateWord(candidate.state, candidate.outcome)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {reviewable(intent) ? (
          // 켬/끔은 콘솔 공용 스위치 한 모양 — 목표에 저장되고 다음 개시에도 남는다.
          <div className="objectives-routing-switch">
            <SettingsToggle checked={confirmOn} busy={sending} ariaLabel={t("objectives.routing.confirm")}
              onChange={(next) => void request("/objective/patch", { objectiveId, patch: { routingConfirm: next } }).catch((failure: unknown) => setError(t("objectives.band.failedAction", { reason: t("objectives.band.reason.other", { code: failure instanceof Error ? failure.message : "unknown" }) })))} />
            <span className="objectives-routing-switch-copy"><b>{t("objectives.routing.confirm")}</b><span>{t("objectives.routing.confirmHint", { count: routeCount })}</span></span>
          </div>
        ) : null}
        {current.talk ? (
          <>
            {(intent === "steer" || intent === "steerIdle") && kinds.length ? (
              <div className="objectives-comp-edits"><span>{t("objectives.band.edits")}</span>{kinds.map((kind) => <span key={kind} className="objectives-comp-chip">{kind}</span>)}</div>
            ) : null}
            <div className="objectives-comp-field">
              <SyncedTextarea
                ref={fieldRef}
                rows={2}
                maxLength={MAX_CONTEXT}
                value={draft}
                // 보내는 중에는 고칠 수만 없게 한다 — disabled면 Enter로 막 보낸 칸에서 포커스가 문서로 빠진다.
                readOnly={sending}
                aria-busy={sending || undefined}
                required={intent === "extend"}
                placeholder={current.placeholder}
                aria-label={intent === "message" ? current.placeholder : t("objectives.band.fieldAria", { word: current.word })}
                onChange={(event) => { setDraft(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (sendKey(event)) { event.preventDefault(); void run(intent); } }}
              />
              {draft.length >= COUNT_FROM ? <span className="objectives-comp-count" aria-live="polite">{MAX_CONTEXT - draft.length}</span> : null}
            </div>
          </>
        ) : null}
        {errorLine}
        <button
          type="button"
          className={`objectives-start objectives-comp-send${current.tone ? ` is-${current.tone === "aurora" ? "review" : "stop"}` : ""}`}
          // 보내는 중은 aria-disabled로만 막는다(run이 sending을 다시 거른다) — native disabled는 막 누른 버튼의 포커스를 문서로 떨군다.
          disabled={unavailable(intent) || (intent === "extend" && !draft.trim()) || (intent === "message" && recipientBlocked)}
          aria-disabled={sending || undefined}
          aria-busy={sending || undefined}
          title={unavailable(intent) ? t("objectives.commander.unavailable") : undefined}
          onClick={() => void run(intent)}
        >
          {intent === "message" && recipient ? <span className="objectives-start-word">{t("objectives.band.message.to", { role: recipient.role })}</span> : willReview(intent) ? <span className="objectives-start-word">{t("objectives.routing.review")}</span> : word(current)}
          <span className="objectives-start-sub">{pending ? pendingText(pending) : intent === "message" && recipient ? messageHow(recipient) : willReview(intent) ? t("objectives.routing.reviewSub") : current.talk ? t("objectives.band.keys") : current.desc}</span>
          <span className="objectives-start-arrow" aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
