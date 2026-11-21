import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useViewportFit } from "@fleet-console/ui/react";

import { commodoreAvatarKey, commodoreIdOfAvatarKey, isPromotedBaseId, mongleStateOf, mongleVoiceOf, objectiveRecordAvatarKey, type MongleFacts, type MongleRole, type MongleState } from "../shared/avatars.js";
import { claimMongleLooks, drawMongleBase, resolveMongleLook, setMongleLook, useAvatarBook, useMongleLook } from "./avatar-events.js";
import { MongleAvatar } from "./components/mongle-avatar.js";
import type { ObjectiveCluster } from "../../objectives/shared/objective-clusters.js";
import { MongleAvatarPicker, type MongleAvatarPickerLabels, type MongleAvatarPreviewState } from "./components/mongle-avatar-picker.js";
import { IDENTITY_TONES, type IdentityTone } from "../shared/identity-tones.js";

import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale, useT } from "../../../core/client/src/i18n/index.js";
import type { ConsoleState, ObjectiveRecord } from "../../../core/client/src/integration/types.js";
import { resolveObjectiveActivity, type ObjectiveMarkVisual } from "../../execution/client/objective-activity.js";
import { useObjectiveMongleActivity } from "../../execution/client/avatar-activity.js";
import { readCommodoreList, useCommodoreList } from "../../commodore/client/commodore-list.js";
import { useCommodoreMongleActivity } from "../../commodore/client/commodore-avatar.js";

/**
 * 몽글 아바타의 Console 쪽 — 누구에게 어떤 역할이 붙는지, 처음 배정을 누가 맡는지, 대화 중심 화면의 편집기.
 *
 * 역할: 부모 Objective 이 있는 Objective 은 구성원, 그 밖의 Objective(목표의 뿌리와 일반 Objective)은 지휘관 안테나, 사령관(UUID)은 사령관.
 * 배정: 사이드바가 한 곳(`useAvatarClaims`)에서 아직 모습이 없는 키를 묶음째 뽑는다 — 같은 사령관의 사령관·지휘관끼리,
 * 같은 부모의 구성원끼리 겹치지 않게. 다른 표면은 읽기만 하고, 저장값이 없으면 키에서 정한 베이스를 그린다.
 */

export function objectiveRecordAvatarRole(objectiveRecord: Pick<ObjectiveRecord, "parentObjectiveId">): MongleRole {
  return objectiveRecord.parentObjectiveId ? "member" : "commander";
}

/** 묶음에서 읽는 얼굴 사실 — 뿌리면 검토 대기·사람 차례, 구성원이면 맡은 임무가 모두 끝났는지. */
export type ClusterFaceFacts = Pick<MongleFacts, "awaitingReview" | "personTurn" | "workDone">;

export function clusterFaceFacts(clusters: readonly ObjectiveCluster[], objectiveId: string): ClusterFaceFacts {
  for (const cluster of clusters) {
    if (cluster.root === objectiveId) return { awaitingReview: cluster.row?.glyph === "review", personTurn: cluster.row?.personTurnAt !== undefined };
    const own = cluster.members.filter((member) => !member.pending && member.objectiveId === objectiveId);
    // 구성원의 진행은 대표 임무의 것이다 — 끝나지 않은 임무가 남아 있으면 그것이 대표라 done 은 「모두 끝남」이다.
    if (own.length > 0) return { workDone: own.every((member) => member.progress === "done") };
  }
  return {};
}

/**
 * 사이드바 표식 축(상태 마크) → 아바타 상태. 표식의 unseen 은 활동이 쉼이고 안 본 답이 도착한 것이다 — 통일 기준의 예외로
 * 사이드바만 표식째 넘긴다. 사람 차례·검토 대기·임무 완료는 활동 축과 별개의 사실이라 따로 받는다.
 */
export function mongleStateOfMark(mark: ObjectiveMarkVisual | undefined, facts: Omit<MongleFacts, "activity" | "unseen"> = {}): MongleState {
  return mongleStateOf({ ...facts, activity: mark === "unseen" ? "idle" : mark ?? null, unseen: mark === "unseen" });
}

/**
 * Objective 하나의 얼굴 — 사이드바 밖 표면(지휘관 레일·대화 머리·그룹 구성원 탭)이 쓴다. 활동은 Console 의 공개 축이라
 * 지휘관은 구성원 활동을 끌어올린 값, 구성원은 자기 값이다. Objective 이 없으면 시작 전이다. 안 본 답은 읽지 않는다.
 */
export function objectiveRecordMongleState(
  objectiveId: string,
  state: Pick<ConsoleState, "objectiveRecords" | "nestedObjectiveRecords" | "objectiveRecordRuntime">,
  clusters: readonly ObjectiveCluster[],
): MongleState {
  const objectiveRecord = state.nestedObjectiveRecords.find((node) => node.id === objectiveId) ?? state.objectiveRecords.find((node) => node.id === objectiveId);
  if (!objectiveRecord) return mongleStateOf({ session: false });
  return mongleStateOf({ activity: resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime), ...clusterFaceFacts(clusters, objectiveId) });
}

/** 일하는 구성원으로 치는 표식 — 진행·부름·안 본 답. 쉬거나 끝난 구성원은 줄 앞 미니 아바타에 서지 않는다. */
const WORKING_MARKS: ReadonlySet<ObjectiveMarkVisual> = new Set(["running", "awaiting", "unseen"]);

export interface ClusterWorkingMember {
  readonly objectiveRecord: ObjectiveRecord;
  readonly mark: ObjectiveMarkVisual;
}

/**
 * 묶음 지휘관 옆에 미니 아바타로 서는, 지금 일하는 구성원(최대 `limit`). 사이드바 줄과 모바일 대화 행이 같은 셈법을 읽는다.
 * 구성원은 묶음의 구성원 목록에서 뿌리를 뺀 것이고(`fold` 에는 뿌리가 함께 들 수 있다), 표식은 `marks`(사이드바 표식)가 있으면 그것을,
 * 없으면 런타임 활동을 쓴다. 자리표시(pending)와 Objective 이 아직 없는 구성원은 서지 않는다.
 */
export function clusterWorkingMembers(
  cluster: ObjectiveCluster,
  rootId: string | undefined,
  state: Pick<ConsoleState, "objectiveRecords" | "nestedObjectiveRecords" | "objectiveRecordRuntime">,
  marks?: ReadonlyMap<string, ObjectiveMarkVisual>,
  limit = 3,
): readonly ClusterWorkingMember[] {
  const working: ClusterWorkingMember[] = [];
  for (const member of cluster.members) {
    if (member.pending || member.objectiveId === rootId || working.length >= limit) continue;
    const objectiveRecord = state.nestedObjectiveRecords.find((node) => node.id === member.objectiveId) ?? state.objectiveRecords.find((node) => node.id === member.objectiveId);
    if (!objectiveRecord) continue;
    const mark = marks?.get(objectiveRecord.id) ?? resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime);
    if (WORKING_MARKS.has(mark)) working.push({ objectiveRecord, mark });
  }
  return working;
}

const byCreation = (left: ObjectiveRecord, right: ObjectiveRecord) => left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);

/** 배정 묶음 — 묶음 안에서는 겹치지 않게 뽑는다. 사령관 묶음의 첫 키는 사령관 자신이고, 뒤는 그 사령관이 소유한 최상위 Objective 이다. */
export function avatarClaimGroups(commodoreIds: readonly string[], state: Pick<ConsoleState, "objectiveRecords" | "nestedObjectiveRecords">): string[][] {
  const groups: string[][] = [];
  for (const commodoreId of commodoreIds) {
    const objectiveRecords = state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === commodoreId && !objectiveRecord.parentObjectiveId).sort(byCreation);
    groups.push([commodoreAvatarKey(commodoreId), ...objectiveRecords.map((objectiveRecord) => objectiveRecordAvatarKey(objectiveRecord.id))]);
  }
  const children = new Map<string, ObjectiveRecord[]>();
  for (const objectiveRecord of [...state.objectiveRecords, ...state.nestedObjectiveRecords]) {
    if (!objectiveRecord.parentObjectiveId) continue;
    const list = children.get(objectiveRecord.parentObjectiveId) ?? [];
    if (!list.some((existing) => existing.id === objectiveRecord.id)) list.push(objectiveRecord);
    children.set(objectiveRecord.parentObjectiveId, list);
  }
  for (const list of children.values()) groups.push(list.sort(byCreation).map((objectiveRecord) => objectiveRecordAvatarKey(objectiveRecord.id)));
  return groups.filter((group) => group.length > 0);
}

/** 사이드바가 한 번 마운트한다 — Theater·Objective 이 처음 보이면 묶음째 뽑아 저장한다. 이미 저장된 키는 건드리지 않는다. */
export function useAvatarClaims(): void {
  const state = useConsoleState();
  const commodores = useCommodoreList();
  const book = useAvatarBook();
  const groups = useMemo(() => avatarClaimGroups(commodores.map((row) => row.commodoreId), state), [commodores, state.objectiveRecords, state.nestedObjectiveRecords]);
  const signature = groups.map((group) => group.join(",")).join("|");
  useEffect(() => {
    if (!book) return;
    if (groups.every((group) => group.every((key) => book[key]))) return;
    void claimMongleLooks(groups);
    // 책이 바뀔 때마다가 아니라 묶음이 바뀌거나 책이 처음 읽혔을 때만 — 배정 응답이 다시 이 효과를 부르지 않게 한다.
  }, [signature, book === null]);
}

/** 편집기의 「다시 뽑기」가 피할 형제 키. */
function siblingKeysOf(state: Pick<ConsoleState, "objectiveRecords" | "nestedObjectiveRecords">, key: string): string[] {
  return avatarClaimGroups(readCommodoreList().map((row) => row.commodoreId), state).find((group) => group.includes(key))?.filter((candidate) => candidate !== key) ?? [];
}

interface ObjectiveAvatarProps {
  readonly objectiveRecord: Pick<ObjectiveRecord, "id" | "parentObjectiveId">;
  readonly state: MongleState;
  readonly size: number;
  readonly label: string;
  readonly role?: MongleRole;
  readonly decorative?: boolean;
  readonly className?: string;
}

/** Objective 의 아바타 — 작업 중이면 그 Objective 이 지금 하는 일을 연기한다. */
export function ObjectiveAvatar({ objectiveRecord, state, size, label, role, decorative, className }: ObjectiveAvatarProps) {
  const look = useMongleLook(objectiveRecordAvatarKey(objectiveRecord.id));
  const activity = useObjectiveMongleActivity(state === "running" ? objectiveRecord.id : null);
  return <MongleAvatar base={look.base} tone={look.tone} role={role ?? objectiveRecordAvatarRole(objectiveRecord)} state={state} activity={activity} size={size} label={label} decorative={decorative} className={className} />;
}

export function KeyedAvatar({ avatarKey, role, state, activityObjectiveId, size, label, decorative, className, figure }: {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly state: MongleState;
  /** 이 얼굴이 대표하는 Objective — 있으면 작업 중일 때 그 Objective 이 지금 하는 일을 연기한다. */
  readonly activityObjectiveId?: string | null;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  readonly className?: string;
  /** 진급 사령관을 견장·날개 윗부분과 날개짓까지 그린다 — 큰 자리 전용. */
  readonly figure?: boolean;
}) {
  const look = useMongleLook(avatarKey);
  const objectiveActivity = useObjectiveMongleActivity(state === "running" ? activityObjectiveId : null);
  // 사령관은 Objective이 아니라 키에서 UUID를 꺼내 턴의 계열을 읽는다 — `CommodoreAvatar`와 같은 연기다.
  const commodoreActivity = useCommodoreMongleActivity(state === "running" && role === "commodore" ? commodoreIdOfAvatarKey(avatarKey) : null);
  return <MongleAvatar base={look.base} tone={look.tone} role={role} state={state} activity={objectiveActivity ?? commodoreActivity} size={size} label={label} decorative={decorative} className={className} figure={figure} />;
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
    promotedGroup: t("avatar.editor.promotedGroup"),
    toneLocked: t("avatar.editor.toneLocked"),
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

interface Undo {
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly voiceChanged: boolean;
}

/**
 * 편집 한 번의 상태 — 고르는 동안의 미리보기(draft), 적용 중(busy), 적용 뒤 한동안의 「되돌리기」(undo).
 * 오른쪽 패널 머리·구성원 탭의 `AvatarEditor` 와 사이드바 「사령관 설정」의 `AnchoredAvatarEditor` 가 같은 것을 쓴다.
 */
interface AvatarEditorSession {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly look: ReturnType<typeof resolveMongleLook>;
  readonly draft: Draft | null;
  readonly busy: boolean;
  readonly undo: Undo | null;
  readonly begin: () => void;
  readonly discard: () => void;
  readonly update: (next: Draft) => void;
  readonly reroll: () => void;
  /** 저장에 성공하면 true — 판을 닫고 「되돌리기」를 세운다. */
  readonly apply: () => Promise<boolean>;
  readonly revert: () => Promise<void>;
}

function useAvatarEditorSession(avatarKey: string, role: MongleRole, state: MongleState): AvatarEditorSession {
  const consoleState = useConsoleState();
  const book = useAvatarBook();
  const look = resolveMongleLook(book, avatarKey);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  // 다른 대상으로 옮겨 가면 고르던 것은 버린다.
  useEffect(() => { setDraft(null); setUndo(null); }, [avatarKey]);
  return {
    avatarKey,
    role,
    look,
    draft,
    busy,
    undo,
    begin: () => setDraft({ base: look.base, tone: look.tone, dirty: false, previewState: state === "running" || state === "awaiting" || state === "unseen" || state === "ended" ? state : "idle" }),
    discard: () => setDraft(null),
    update: setDraft,
    reroll: () => { if (draft) setDraft({ ...draft, base: drawMongleBase(book, siblingKeysOf(consoleState, avatarKey), draft.base), tone: null, dirty: true }); },
    apply: async () => {
      if (!draft) return false;
      const previous = { base: look.base, tone: look.tone };
      setBusy(true);
      const ok = await setMongleLook(avatarKey, draft.base, draft.tone);
      setBusy(false);
      if (!ok) return false;
      setDraft(null);
      // 사령관의 응답 말투(진급 캐릭터)가 바뀌면 다음 턴부터 새 세션이 답한다 — 서버가 세션을 바꾸고, 여기서는 그것을 알린다.
      setUndo({ ...previous, voiceChanged: role === "commodore" && mongleVoiceOf(previous.base) !== mongleVoiceOf(draft.base) });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 8000);
      return true;
    },
    revert: async () => {
      if (!undo) return;
      const target = undo;
      setUndo(null);
      await setMongleLook(avatarKey, target.base, target.tone);
    },
  };
}

/**
 * 아바타 자리에 붙어 떠 있는 판 — 좌표만 앵커에 맞춘다. 레일 칸이 overflow: hidden 이라 absolute 는 잘리므로 position: fixed 로 띄운다.
 * 세로: 앵커 아래 --space-2(8px) 간격. 가로: stack 은 앵커 가운데, inline 은 앵커 왼쪽 끝. 창 밖으로 나가는 몫은 뒤이은
 * useViewportFit 이 밀어 넣는다(같은 컴포넌트의 layout effect 는 선언 순서로 돈다).
 */
function useAnchoredPlacement(panelRef: RefObject<HTMLElement | null>, anchorRef: RefObject<HTMLElement | null>, open: boolean, layout: "stack" | "inline"): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!open || !panel || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      panel.style.top = `${Math.round(rect.bottom + 8)}px`;
      panel.style.left = `${Math.round(layout === "inline" ? rect.left : rect.left + rect.width / 2)}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, layout]);
  useViewportFit(panelRef, open);
}

/** 편집기 판 — 피커와 그 판의 자리·바깥 누름·Esc. 판을 여닫는 일과 앵커의 미리보기는 부르는 쪽이 한다. */
function AvatarEditorPopover({ session, anchorRef, layout, portal = false, autoFocus = false, onClose }: {
  readonly session: AvatarEditorSession;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly layout: "stack" | "inline";
  /** 판을 body 로 옮긴다 — 앵커가 쌓임 맥락에 갇힌 자리(사이드바)에서 판이 다른 칸 아래로 들어가지 않게. */
  readonly portal?: boolean;
  /** 열리자마자 판에 포커스를 둔다 — 메뉴에서 연 판은 앵커가 단추가 아니라 Tab 으로 닿을 수 없다. */
  readonly autoFocus?: boolean;
  /** 취소·Esc·적용으로 닫을 때 — 포커스를 돌려줄 자리는 부르는 쪽이 안다. 바깥 누름은 포커스를 끌어오지 않으므로 부르지 않는다. */
  readonly onClose: () => void;
}) {
  const locale = useConsoleLocale() === "ko" ? "ko" : "en";
  const labels = usePickerLabels();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { draft, look } = session;
  const open = draft !== null;
  useAnchoredPlacement(panelRef, anchorRef, open, layout);
  useEffect(() => { if (open && autoFocus) panelRef.current?.focus({ preventScroll: true }); }, [open, autoFocus]);
  // 바깥 누름 — 판과 앵커 밖을 pointerdown 하면 고르던 것을 버리고 닫는다. 닫은 뒤 포커스는 끌어오지 않는다(누른 곳의 동작을 방해하지 않게).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null) {
        if (anchorRef.current?.contains(target)) return;
        if (panelRef.current?.contains(target)) return;
      }
      session.discard();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  if (!draft) return null;
  const cancel = () => { session.discard(); onClose(); };
  // 포털로 옮긴 판에서도 React 이벤트는 컴포넌트 부모로 번진다 — 사이드바 행의 드래그·우클릭·더블클릭이 판의 누름을 받지 않게 여기서 멈춘다.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const panel = (
    <div
      data-covers-native-view=""
      ref={panelRef}
      className={`avatar-editor-popover is-${layout}`}
      role="dialog"
      aria-label={labels.heading}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (portal || event.key === "Escape") event.stopPropagation();
        if (event.key === "Escape") cancel();
      }}
      {...(portal ? { onPointerDown: stop, onClick: stop, onDoubleClick: stop, onContextMenu: stop } : {})}
    >
      <MongleAvatarPicker
        className="avatar-editor-picker"
        role={session.role}
        base={draft.base}
        tone={draft.tone}
        previewState={draft.previewState}
        locale={locale}
        labels={labels}
        dirty={draft.dirty && (draft.base !== look.base || draft.tone !== look.tone)}
        busy={session.busy}
        // 진급 캐릭터는 색이 시그니처로 잠긴다 — 고르던 색은 버린다.
        onBase={(base) => session.update({ ...draft, base, tone: isPromotedBaseId(base) ? null : draft.tone, dirty: true })}
        onTone={(tone) => session.update({ ...draft, tone, dirty: true })}
        onPreviewState={(previewState) => session.update({ ...draft, previewState })}
        onReroll={session.reroll}
        onReset={() => session.update({ ...draft, base: look.origin, tone: null, dirty: true })}
        onCancel={cancel}
        onApply={() => { void session.apply().then((ok) => { if (ok) onClose(); }); }}
      />
    </div>
  );
  return portal ? createPortal(panel, document.body) : panel;
}

/** 적용 뒤 한동안 서는 줄 — 「적용했어요 · 되돌리기」, 사령관 말투가 바뀌었으면 다음 턴부터라는 안내. */
function AvatarEditorUndo({ session, className }: { readonly session: AvatarEditorSession; readonly className?: string }) {
  const t = useT();
  if (!session.undo || session.draft) return null;
  return (
    <div className={`avatar-editor-undo${className ? ` ${className}` : ""}`} role="status">
      <span>{t("avatar.editor.applied")}</span>
      {session.undo.voiceChanged ? <span className="avatar-editor-undo-note">{t("avatar.editor.voiceNextTurn")}</span> : null}
      <button type="button" className="avatar-editor-undo-button" onClick={() => { void session.revert(); }}>{t("avatar.editor.undo")}</button>
    </div>
  );
}

/**
 * 아바타를 고치는 자리 — 대화 중심 화면의 프로필 팝오버·패널 머리가 쓴다(일반 화면에는 편집 진입이 없다).
 *
 * 아바타를 누르면 편집기가 열리고, 고르는 동안은 미리보기만 바뀐다. 「적용」해야 저장되며, 적용 뒤 한동안 「되돌리기」가 선다.
 * 「다시 뽑기」는 형제와 겹치지 않는 캐릭터를 원래 색으로, 「처음 값으로」는 처음 뽑힌 캐릭터를 원래 색으로 미리보기에 세운다.
 */
export function AvatarEditor({ avatarKey, role, state, activityObjectiveId, size, label, figure }: {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly state: MongleState;
  /** 이 얼굴이 대표하는 Objective — 있으면 작업 중일 때 그 Objective 이 지금 하는 일을 연기한다(편집 미리보기 중에는 연기하지 않는다). */
  readonly activityObjectiveId?: string | null;
  readonly size: number;
  readonly label: string;
  /** 진급 사령관을 견장·날개 윗부분과 날개짓까지 그린다 — 큰 얼굴 전용. */
  readonly figure?: boolean;
}) {
  const t = useT();
  const session = useAvatarEditorSession(avatarKey, role, state);
  const { draft, look } = session;
  const objectiveActivity = useObjectiveMongleActivity(state === "running" && draft === null ? activityObjectiveId : null);
  // 사령관은 Objective이 아니라 키에서 UUID를 꺼내 턴의 계열을 읽는다 — `CommodoreAvatar`와 같은 연기다.
  const commodoreActivity = useCommodoreMongleActivity(state === "running" && draft === null && role === "commodore" ? commodoreIdOfAvatarKey(avatarKey) : null);
  const activity = objectiveActivity ?? commodoreActivity;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const open = draft !== null;
  const shown = draft ?? { base: look.base, tone: look.tone };
  const close = () => { session.discard(); triggerRef.current?.focus(); };

  return (
    <div className={`avatar-editor is-stack${open ? " is-open" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      <button
        ref={triggerRef}
        type="button"
        className="avatar-editor-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("avatar.editor.open", { name: label })}
        title={t("avatar.editor.open", { name: label })}
        onClick={() => { if (open) session.discard(); else session.begin(); }}
      >
        {/* 대상이 바뀌면 새 얼굴로 다시 선다 — 이전 대상의 활동 교체 시계(최소 머무름·경계 대기)를 이어받지 않는다. */}
        <MongleAvatar key={avatarKey} base={shown.base} tone={shown.tone} role={role} state={draft ? draft.previewState : state} activity={activity} size={size} label={label} decorative figure={figure} />
        <span className="avatar-editor-pen" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M3 13l.7-2.8L10.6 3.3l2.1 2.1-6.9 6.9z" fill="currentColor" /></svg>
        </span>
      </button>
      <AvatarEditorUndo session={session} />
      <AvatarEditorPopover session={session} anchorRef={triggerRef} layout="stack" onClose={() => triggerRef.current?.focus()} />
    </div>
  );
}

/**
 * 메뉴에서 여는 같은 편집기 — 사이드바 사령관 행의 「사령관 설정」. 행의 아바타 자리를 대신 그려 미리보기를 싣고, 판은 그 아바타
 * 왼쪽 끝 아래에 body 로 옮겨 띄운다. 올라오자마자 판이 열리며, 판이 닫히고 「되돌리기」 줄까지 사라지면 `onDone` 을 부른다.
 */
export function AnchoredAvatarEditor({ avatarKey, role, state, size, figure, onReturnFocus, onDone }: {
  readonly avatarKey: string;
  readonly role: MongleRole;
  readonly state: MongleState;
  readonly size: number;
  /** 진급 사령관을 견장·날개 윗부분까지 그린다 — 행이 원래 세우던 얼굴과 같은 모양으로 미리본다. */
  readonly figure?: boolean;
  /** 취소·Esc·적용으로 판을 닫았을 때 포커스를 돌려줄 자리 — 앵커인 아바타는 단추가 아니다. */
  readonly onReturnFocus: () => void;
  readonly onDone: () => void;
}) {
  const session = useAvatarEditorSession(avatarKey, role, state);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const undoRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const { draft, look, undo } = session;
  useEffect(() => { session.begin(); }, []);
  useEffect(() => {
    if (draft) startedRef.current = true;
    else if (startedRef.current && !undo) onDone();
  }, [draft, undo]);
  useAnchoredPlacement(undoRef, anchorRef, undo !== null && draft === null, "inline");
  const shown = draft ?? { base: look.base, tone: look.tone };
  return (
    <span ref={anchorRef} className="avatar-editor-anchor">
      <MongleAvatar key={avatarKey} base={shown.base} tone={shown.tone} role={role} state={draft ? draft.previewState : state} size={size} label="" decorative figure={figure} />
      <AvatarEditorPopover session={session} anchorRef={anchorRef} layout="inline" portal autoFocus onClose={onReturnFocus} />
      {undo && !draft ? createPortal(<div ref={undoRef} className="avatar-editor-undo-float"><AvatarEditorUndo session={session} /></div>, document.body) : null}
    </span>
  );
}
