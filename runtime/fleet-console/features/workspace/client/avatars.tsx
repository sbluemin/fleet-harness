import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { mongleStateOf, operationAvatarKey, theaterAvatarKey, type MongleFacts, type MongleRole, type MongleState } from "@fleet-console/sdk/avatars";
import { claimMongleLooks, drawMongleBase, resolveMongleLook, setMongleLook, useAvatarBook, useMongleLook } from "@fleet-console/sdk/avatars/browser";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";
import type { OperationCluster } from "@fleet-console/sdk/plugin";
import { MongleAvatarPicker, type MongleAvatarPickerLabels, type MongleAvatarPreviewState } from "@fleet-console/sdk/components/mongle-avatar-picker";
import { IDENTITY_TONES, type IdentityTone } from "@fleet-console/sdk/operations/identity-tones";

import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale, useT } from "../../../core/client/src/i18n/index.js";
import type { ConsoleState, OperationNode } from "../../../core/client/src/integration/types.js";
import { resolveOperationActivity, type OperationMarkVisual } from "../../execution/client/operation-activity.js";
import { useOperationMongleActivity } from "../../execution/client/avatar-activity.js";

/**
 * 몽글 아바타의 Console 쪽 — 누구에게 어떤 역할이 붙는지, 처음 배정을 누가 맡는지, 대화 중심 화면의 편집기.
 *
 * 역할: 부모 Operation 이 있는 Operation 은 구성원, 그 밖의 Operation(목표의 뿌리와 일반 Operation)은 지휘관 안테나, Theater 는 사령관.
 * 배정: 사이드바가 한 곳(`useAvatarClaims`)에서 아직 모습이 없는 키를 묶음째 뽑는다 — 같은 Theater 의 사령관·지휘관끼리,
 * 같은 부모의 구성원끼리 겹치지 않게. 다른 표면은 읽기만 하고, 저장값이 없으면 키에서 정한 베이스를 그린다.
 */

export function operationAvatarRole(operation: Pick<OperationNode, "parentOperationId">): MongleRole {
  return operation.parentOperationId ? "member" : "commander";
}

/** 묶음에서 읽는 얼굴 사실 — 뿌리면 검토 대기·결정 요청, 구성원이면 맡은 임무가 모두 끝났는지. */
export type ClusterFaceFacts = Pick<MongleFacts, "awaitingReview" | "decisionRequest" | "workDone">;

export function clusterFaceFacts(clusters: readonly OperationCluster[], operationId: string): ClusterFaceFacts {
  for (const cluster of clusters) {
    if (cluster.root === operationId) return { awaitingReview: cluster.row?.glyph === "review", decisionRequest: cluster.decisionRequest === true };
    const own = cluster.members.filter((member) => !member.pending && member.operationId === operationId);
    // 구성원의 진행은 대표 임무의 것이다 — 끝나지 않은 임무가 남아 있으면 그것이 대표라 done 은 「모두 끝남」이다.
    if (own.length > 0) return { workDone: own.every((member) => member.progress === "done") };
  }
  return {};
}

/**
 * 사이드바 표식 축(상태 마크) → 아바타 상태. 표식의 unseen 은 활동이 쉼이고 안 본 답이 도착한 것이다 — 통일 기준의 예외로
 * 사이드바만 표식째 넘긴다. 결정 요청·검토 대기·임무 완료는 활동 축과 별개의 사실이라 따로 받는다.
 */
export function mongleStateOfMark(mark: OperationMarkVisual | undefined, facts: Omit<MongleFacts, "activity" | "unseen"> = {}): MongleState {
  return mongleStateOf({ ...facts, activity: mark === "unseen" ? "idle" : mark ?? null, unseen: mark === "unseen" });
}

/**
 * Operation 하나의 얼굴 — 사이드바 밖 표면(지휘관 탭 레일·대화 머리·그룹 구성원 탭)이 쓴다. 활동은 Console 의 공개 축이라
 * 지휘관은 구성원 활동을 끌어올린 값, 구성원은 자기 값이다. Operation 이 없으면 시작 전이다. 안 본 답은 읽지 않는다.
 */
export function operationMongleState(
  operationId: string,
  state: Pick<ConsoleState, "operations" | "nestedOperations" | "operationRuntime">,
  clusters: readonly OperationCluster[],
): MongleState {
  const operation = state.nestedOperations.find((node) => node.id === operationId) ?? state.operations.find((node) => node.id === operationId);
  if (!operation) return mongleStateOf({ session: false });
  return mongleStateOf({ activity: resolveOperationActivity(operation, state.operationRuntime), ...clusterFaceFacts(clusters, operationId) });
}

/** 일하는 구성원으로 치는 표식 — 진행·부름·안 본 답. 쉬거나 끝난 구성원은 줄 앞 미니 아바타에 서지 않는다. */
const WORKING_MARKS: ReadonlySet<OperationMarkVisual> = new Set(["running", "awaiting", "unseen"]);

export interface ClusterWorkingMember {
  readonly operation: OperationNode;
  readonly mark: OperationMarkVisual;
}

/**
 * 묶음 지휘관 옆에 미니 아바타로 서는, 지금 일하는 구성원(최대 `limit`). 사이드바 줄과 모바일 대화 행이 같은 셈법을 읽는다.
 * 구성원은 묶음의 구성원 목록에서 뿌리를 뺀 것이고(`fold` 에는 뿌리가 함께 들 수 있다), 표식은 `marks`(사이드바 표식)가 있으면 그것을,
 * 없으면 런타임 활동을 쓴다. 자리표시(pending)와 Operation 이 아직 없는 구성원은 서지 않는다.
 */
export function clusterWorkingMembers(
  cluster: OperationCluster,
  rootId: string | undefined,
  state: Pick<ConsoleState, "operations" | "nestedOperations" | "operationRuntime">,
  marks?: ReadonlyMap<string, OperationMarkVisual>,
  limit = 3,
): readonly ClusterWorkingMember[] {
  const working: ClusterWorkingMember[] = [];
  for (const member of cluster.members) {
    if (member.pending || member.operationId === rootId || working.length >= limit) continue;
    const operation = state.nestedOperations.find((node) => node.id === member.operationId) ?? state.operations.find((node) => node.id === member.operationId);
    if (!operation) continue;
    const mark = marks?.get(operation.id) ?? resolveOperationActivity(operation, state.operationRuntime);
    if (WORKING_MARKS.has(mark)) working.push({ operation, mark });
  }
  return working;
}

const byCreation = (left: OperationNode, right: OperationNode) => left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);

/** 배정 묶음 — 묶음 안에서는 겹치지 않게 뽑는다. Theater 묶음의 첫 키는 사령관이다. */
export function avatarClaimGroups(state: Pick<ConsoleState, "theaters" | "operations" | "nestedOperations">): string[][] {
  const groups: string[][] = [];
  for (const theater of state.theaters) {
    const operations = state.operations.filter((operation) => operation.theaterId === theater.id && !operation.parentOperationId).sort(byCreation);
    groups.push([theaterAvatarKey(theater.id), ...operations.map((operation) => operationAvatarKey(operation.id))]);
  }
  const children = new Map<string, OperationNode[]>();
  for (const operation of [...state.operations, ...state.nestedOperations]) {
    if (!operation.parentOperationId) continue;
    const list = children.get(operation.parentOperationId) ?? [];
    if (!list.some((existing) => existing.id === operation.id)) list.push(operation);
    children.set(operation.parentOperationId, list);
  }
  for (const list of children.values()) groups.push(list.sort(byCreation).map((operation) => operationAvatarKey(operation.id)));
  return groups.filter((group) => group.length > 0);
}

/** 사이드바가 한 번 마운트한다 — Theater·Operation 이 처음 보이면 묶음째 뽑아 저장한다. 이미 저장된 키는 건드리지 않는다. */
export function useAvatarClaims(): void {
  const state = useConsoleState();
  const book = useAvatarBook();
  const groups = useMemo(() => avatarClaimGroups(state), [state.theaters, state.operations, state.nestedOperations]);
  const signature = groups.map((group) => group.join(",")).join("|");
  useEffect(() => {
    if (!book) return;
    if (groups.every((group) => group.every((key) => book[key]))) return;
    void claimMongleLooks(groups);
    // 책이 바뀔 때마다가 아니라 묶음이 바뀌거나 책이 처음 읽혔을 때만 — 배정 응답이 다시 이 효과를 부르지 않게 한다.
  }, [signature, book === null]);
}

/** 편집기의 「다시 뽑기」가 피할 형제 키. */
function siblingKeysOf(state: Pick<ConsoleState, "theaters" | "operations" | "nestedOperations">, key: string): string[] {
  return avatarClaimGroups(state).find((group) => group.includes(key))?.filter((candidate) => candidate !== key) ?? [];
}

interface OperationAvatarProps {
  readonly operation: Pick<OperationNode, "id" | "parentOperationId">;
  readonly state: MongleState;
  readonly size: number;
  readonly label: string;
  readonly role?: MongleRole;
  readonly decorative?: boolean;
  readonly className?: string;
}

/** Operation 의 아바타 — 작업 중이면 그 Operation 이 지금 하는 일을 연기한다. */
export function OperationAvatar({ operation, state, size, label, role, decorative, className }: OperationAvatarProps) {
  const look = useMongleLook(operationAvatarKey(operation.id));
  const activity = useOperationMongleActivity(state === "running" ? operation.id : null);
  return <MongleAvatar base={look.base} tone={look.tone} role={role ?? operationAvatarRole(operation)} state={state} activity={activity} size={size} label={label} decorative={decorative} className={className} />;
}

export function KeyedAvatar({ avatarKey, role, state, activityOperationId, size, label, decorative, off, className }: {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly state: MongleState;
  /** 이 얼굴이 대표하는 Operation — 있으면 작업 중일 때 그 Operation 이 지금 하는 일을 연기한다. */
  readonly activityOperationId?: string | null;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  readonly off?: boolean;
  readonly className?: string;
}) {
  const look = useMongleLook(avatarKey);
  const activity = useOperationMongleActivity(state === "running" ? activityOperationId : null);
  return <MongleAvatar base={look.base} tone={look.tone} role={role} state={state} activity={activity} size={size} label={label} decorative={decorative} off={off} className={className} />;
}

function usePickerLabels(): MongleAvatarPickerLabels {
  const t = useT();
  return {
    heading: t("avatar.editor.heading"),
    reroll: t("avatar.editor.reroll"),
    reset: t("avatar.editor.reset"),
    preview: t("avatar.editor.preview"),
    cancel: t("avatar.editor.cancel"),
    apply: t("avatar.editor.apply"),
    toneGroup: t("avatar.editor.toneGroup"),
    baseGroup: t("avatar.editor.baseGroup"),
    states: {
      running: t("avatar.state.running"),
      awaiting: t("avatar.state.awaiting"),
      unseen: t("avatar.state.unseen"),
      idle: t("avatar.state.idle"),
      ended: t("avatar.state.ended"),
    },
    tones: Object.fromEntries(IDENTITY_TONES.map((tone) => [tone, t(`avatar.tone.${tone}` as Parameters<typeof t>[0])])) as Record<IdentityTone, string>,
  };
}

interface Draft {
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly dirty: boolean;
  readonly previewState: MongleAvatarPreviewState;
}

/**
 * 아바타를 고치는 자리 — 대화 중심 화면의 오른쪽 패널 머리와 구성원 탭만 쓴다(일반 화면에는 편집 진입이 없다).
 *
 * 아바타를 누르면 편집기가 열리고, 고르는 동안은 미리보기만 바뀐다. 「적용」해야 저장되며, 적용 뒤 한동안 「되돌리기」가 선다.
 * 「다시 뽑기」는 형제와 겹치지 않는 캐릭터를 원래 색으로, 「처음 값으로」는 처음 뽑힌 캐릭터를 원래 색으로 미리보기에 세운다.
 */
export function AvatarEditor({ avatarKey, role, state, activityOperationId, size, label, layout = "stack", children }: {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly state: MongleState;
  /** 이 얼굴이 대표하는 Operation — 있으면 작업 중일 때 그 Operation 이 지금 하는 일을 연기한다(편집 미리보기 중에는 연기하지 않는다). */
  readonly activityOperationId?: string | null;
  readonly size: number;
  readonly label: string;
  /** stack: 아바타 아래에 편집기가 뜬다(패널 머리). inline: 줄 아래로 펼친다(구성원 탭). */
  readonly layout?: "stack" | "inline";
  /** inline 일 때 아바타 오른쪽에 서는 줄 본문. */
  readonly children?: ReactNode;
}) {
  const t = useT();
  const locale = useConsoleLocale() === "ko" ? "ko" : "en";
  const labels = usePickerLabels();
  const consoleState = useConsoleState();
  const book = useAvatarBook();
  const look = resolveMongleLook(book, avatarKey);
  const [draft, setDraft] = useState<Draft | null>(null);
  const activity = useOperationMongleActivity(state === "running" && draft === null ? activityOperationId : null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ readonly base: number; readonly tone: IdentityTone | null } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  // 다른 대상으로 옮겨 가면 고르던 것은 버린다.
  useEffect(() => { setDraft(null); setUndo(null); }, [avatarKey]);

  const open = draft !== null;
  const shown = draft ?? { base: look.base, tone: look.tone };
  const toggle = () => setDraft(open ? null : { base: look.base, tone: look.tone, dirty: false, previewState: state === "running" || state === "awaiting" || state === "unseen" || state === "ended" ? state : "idle" });
  const close = () => { setDraft(null); triggerRef.current?.focus(); };
  const apply = async () => {
    if (!draft) return;
    const previous = { base: look.base, tone: look.tone };
    setBusy(true);
    const ok = await setMongleLook(avatarKey, draft.base, draft.tone);
    setBusy(false);
    if (!ok) return;
    setDraft(null);
    setUndo(previous);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
    triggerRef.current?.focus();
  };
  const revert = async () => {
    if (!undo) return;
    const target = undo;
    setUndo(null);
    await setMongleLook(avatarKey, target.base, target.tone);
  };

  const avatarButton = (
    <button
      ref={triggerRef}
      type="button"
      className="avatar-editor-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t("avatar.editor.open", { name: label })}
      title={t("avatar.editor.open", { name: label })}
      onClick={toggle}
    >
      {/* 대상이 바뀌면 새 얼굴로 다시 선다 — 이전 대상의 활동 교체 시계(최소 머무름·경계 대기)를 이어받지 않는다. */}
      <MongleAvatar key={avatarKey} base={shown.base} tone={shown.tone} role={role} state={draft ? draft.previewState : state} activity={activity} size={size} label={label} decorative />
      <span className="avatar-editor-pen" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="M3 13l.7-2.8L10.6 3.3l2.1 2.1-6.9 6.9z" fill="currentColor" /></svg>
      </span>
    </button>
  );
  return (
    <div className={`avatar-editor is-${layout}${open ? " is-open" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      {layout === "inline" ? <div className="avatar-editor-row">{avatarButton}{children}</div> : avatarButton}
      {undo && !open ? (
        <div className="avatar-editor-undo" role="status">
          <span>{t("avatar.editor.applied")}</span>
          <button type="button" className="avatar-editor-undo-button" onClick={() => { void revert(); }}>{t("avatar.editor.undo")}</button>
        </div>
      ) : null}
      {draft ? (
        <MongleAvatarPicker
          className="avatar-editor-picker"
          role={role}
          base={draft.base}
          tone={draft.tone}
          previewState={draft.previewState}
          locale={locale}
          labels={labels}
          dirty={draft.dirty && (draft.base !== look.base || draft.tone !== look.tone)}
          busy={busy}
          onBase={(base) => setDraft({ ...draft, base, dirty: true })}
          onTone={(tone) => setDraft({ ...draft, tone, dirty: true })}
          onPreviewState={(previewState) => setDraft({ ...draft, previewState })}
          onReroll={() => setDraft({ ...draft, base: drawMongleBase(book, siblingKeysOf(consoleState, avatarKey), draft.base), tone: null, dirty: true })}
          onReset={() => setDraft({ ...draft, base: look.origin, tone: null, dirty: true })}
          onCancel={close}
          onApply={() => { void apply(); }}
        />
      ) : null}
    </div>
  );
}
