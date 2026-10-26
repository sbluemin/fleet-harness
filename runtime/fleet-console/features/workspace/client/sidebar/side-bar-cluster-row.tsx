import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";

import type { ConsoleLocale, LocalizedText } from "@fleet-console/i18n";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";
import type { ObjectiveClusterRow, ObjectiveClusterRowGlyph, ObjectiveClusterRowMark } from "../../../objectives/shared/objective-clusters.js";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { consoleUseWrapClassName, gestureCallerLabel, getClusterWrap, getObjectiveWrap, subscribeConsoleUseGestures, type ConsoleUseWrap } from "../../../console-use/client/gestures.js";
import { objectiveRecordMarkLabel, resolveObjectiveActivity, resolveObjectiveMarkVisual, type ObjectiveActivityVisual, type ObjectiveMarkVisual } from "../../../execution/client/objective-activity.js";
import { getIdleArrivalIds } from "../../../execution/client/objective-marks.js";
import type { ObjectiveRuntimeState } from "../../../execution/shared/client-contract.js";
import type { ObjectiveNotification, ObjectiveRecord } from "../../../../core/client/src/integration/types.js";
import { sortObjectiveRecordsByOrder } from "../../../../core/client/src/integration/store.js";
import { useInlineRename } from "../../../../core/client/src/integration/use-inline-rename.js";
import { subscribeSideBarObjectiveAction } from "./interaction.js";
import { pointOnText } from "./objective-records-side-bar-hit-test.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { commanderObjectiveId, type ClusterIndex, type ClusterLayout } from "../objective-clusters.js";
import { KeyedAvatar, ObjectiveAvatar, clusterWorkingMembers, mongleStateOfMark } from "../avatars.js";
import { objectiveRecordAvatarKey, theaterAvatarKey, type MongleState } from "../../shared/avatars.js";
import { CONVERSATION_ROW_PHRASE } from "./side-bar-row-style.js";

/**
 * 묶음 줄 — 플러그인이 `row` 로 선언한 묶음(목표)이 사령관 「지휘관」 탭에 서는 한 줄.
 *
 * 뿌리·구성원 Objective 은 이 줄로 접히고, 줄의 글리프는 그중 가장 급한 상태다. 무엇이 검토 대기이고 무엇이 기한을 넘겼는지는
 * 플러그인이 판정해 넘기고, 여기서는 그리기만 진다. 순서는 탭이 고른 정렬이다.
 */


/** 줄 하나가 감싸이는 표식 — 목표 자체, 그다음 접혀 든 뿌리·구성원 Objective. 목록 읽기는 줄이 아니라 머리가 받는다. 저장된 객체를 그대로 돌린다. */
function rowWrapOf(item: SideBarRowItem): ConsoleUseWrap | null {
  const { layout, anchor, fold } = item;
  const direct = getClusterWrap(layout.cluster.id) ?? (anchor ? getObjectiveWrap(anchor.objectiveRecord.id) : null);
  if (direct) return direct;
  for (const entry of fold) {
    const wrap = getObjectiveWrap(entry.objectiveRecord.id);
    if (wrap) return wrap;
  }
  return null;
}

export interface SideBarEntry {
  readonly objectiveRecord: ObjectiveRecord;
  readonly active: boolean;
  readonly notificationCount: number;
  /** 활동 축 — Objective 의 지금 활동. */
  readonly status?: ObjectiveActivityVisual;
  /**
   * 마크 축 — 마크가 그리는 값. 활동과 갈라지는 유일한 값이 "unseen"이다: 사람을 기다리는 줄처럼 앞에 서되 색은 초록(느린
   * 점등)이라, 진짜 대기와 안 본 채 끝난 것이 한 화면에서 구별된다.
   */
  readonly mark?: ObjectiveMarkVisual;
}

/** 사령관 한 명의 Objective 엔트리 — 묶음 줄의 뿌리·접힌 칩이 이 엔트리를 싣는다. */
export function buildTheaterEntries({
  theaterId,
  objectiveRecords,
  objectiveRecordOrder,
  activeObjectiveId,
  objectiveRecordNotifications,
  objectiveRecordRuntime,
}: {
  readonly theaterId: string;
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly objectiveRecordOrder: readonly string[];
  readonly activeObjectiveId: string | null;
  readonly objectiveRecordNotifications: Readonly<Record<string, ObjectiveNotification>>;
  readonly objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>;
}): SideBarEntry[] {
  const idleArrivalIds = getIdleArrivalIds();
  return sortObjectiveRecordsByOrder(
    objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === theaterId),
    objectiveRecordOrder,
  ).map((objectiveRecord) => {
    const activity = resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime);
    return {
      objectiveRecord,
      active: activeObjectiveId === objectiveRecord.id,
      notificationCount: objectiveRecordNotifications[objectiveRecord.id] ? 1 : 0,
      status: activity,
      mark: resolveObjectiveMarkVisual({ activity, objectiveId: objectiveRecord.id, idleArrivalIds }),
    };
  });
}

export interface SideBarRowItem {
  readonly layout: ClusterLayout;
  readonly row: ObjectiveClusterRow;
  /** 뿌리 Objective 이 이 Theater 목록에 서 있으면 그 엔트리 — 끌기·메뉴·포커스가 그 Objective 을 탄다. */
  readonly anchor: SideBarEntry | null;
  readonly fold: readonly SideBarEntry[];
}

// 칩 칸과 같은 셈법: 사람을 기다리는 것이 먼저, 끝난 것이 마지막.
const MARK_URGENCY: Record<ObjectiveMarkVisual, number> = { awaiting: 0, unseen: 1, running: 2, idle: 4, ended: 5 };

export function rowGlyphState(item: SideBarRowItem): ObjectiveClusterRowGlyph | ObjectiveMarkVisual {
  if (item.row.glyph) return item.row.glyph;
  let best: ObjectiveMarkVisual | null = null;
  for (const entry of item.fold) {
    const mark = entry.mark ?? entry.status ?? "idle";
    if (best === null || MARK_URGENCY[mark] < MARK_URGENCY[best]) best = mark;
  }
  return best ?? "ended";
}

/**
 * 그 사령관의 묶음 줄 — 줄을 선언한 묶음마다 하나, 뿌리·접힌 Objective 엔트리를 붙여서. 사이드바 그룹 배치와 사령관 「지휘관」 탭이
 * 같은 줄을 쓴다.
 */
export function sideBarRowItems(
  entries: readonly SideBarEntry[],
  clusterIndex: ClusterIndex,
  allowedRecordIds: ReadonlySet<string>,
  commodoreId: string,
): SideBarRowItem[] {
  const entryById = new Map(entries.map((entry) => [entry.objectiveRecord.id, entry] as const));
  const owns = (id: string | undefined): boolean => id !== undefined && allowedRecordIds.has(id);
  return clusterIndex.rows
    .filter((layout) => layout.cluster.row !== undefined && (layout.cluster.commodoreId !== undefined ? layout.cluster.commodoreId === commodoreId : (
      owns(layout.cluster.id) || owns(layout.cluster.root) || owns(layout.cluster.avatarObjectiveId)
      || layout.cluster.row.fold.some(owns) || layout.cluster.members.some((member) => owns(member.objectiveId))
    )))
    .map((layout) => {
      const row = layout.cluster.row!;
      const fold = row.fold.flatMap((id) => { const entry = entryById.get(id); return entry ? [entry] : []; });
      const root = layout.cluster.root;
      return { layout, row, anchor: (root !== undefined ? entryById.get(root) : undefined) ?? fold[0] ?? null, fold };
    });
}

// 포매터 생성은 비싸다 — 줄이 다시 그려질 때마다 만들지 않고 언어별로 하나를 쓴다.
const dueFormats = new Map<ConsoleLocale, Intl.DateTimeFormat>();

function formatDue(date: string, locale: ConsoleLocale): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  let format = dueFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" });
    dueFormats.set(locale, format);
  }
  return format.format(parsed);
}

/** 대화 중심 화면의 제목 줄 끝에 서는 짧은 기한 — 월/일 숫자만 쓴다(요일은 접근 이름의 긴 표기가 말한다). */
function formatDueShort(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

interface SideBarClusterRowProps {
  readonly item: SideBarRowItem;
  /** 뿌리 Objective 의 사용자 accent — 제목 잉크만 소유한다. */
  readonly accentValue?: string | null;
  /** 뿌리가 선 줄을 누르면 그 지휘관으로 간다 — 사령관 「지휘관」 탭은 대화 옆 칸에 세운다. */
  readonly onFocus: (objectiveId: string) => void;
  readonly selected: boolean;
}

export function SideBarClusterRow({ item, accentValue = null, onFocus, selected }: SideBarClusterRowProps) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = useFeatureRegistry();
  const { layout, row, anchor } = item;
  // Console Use — 에이전트가 이 목표를 읽거나 고치면 Objective 칩과 같은 펄스로 줄 전체가 감싸인다.
  const wrap = useSyncExternalStore(subscribeConsoleUseGestures, () => rowWrapOf(item), () => null);
  const state = rowGlyphState(item);
  // 사령관이 직접 묻는 줄(`commodore`)은 접힌 Objective 도 글리프도 없어 활동 축이 「종료」로 떨어진다 — 그 축 대신 사람의 답을 기다린다고 읽는다.
  const label = row.commodore && !anchor && item.fold.length === 0
    ? t("conversation.row.decision")
    : state === "fresh"
    ? t("sidebar.row.glyph.fresh")
    : state === "review"
      ? t("sidebar.row.glyph.review")
      : state === "done"
        ? t("sidebar.row.glyph.done")
        : objectiveRecordMarkLabel(state);
  // 시작 전 줄도 세션 유무·목표 패널 열림이 아니라 옆 칸의 선택을 따른다.
  const active = selected;
  // 제목 아래에는 상태 문구·진척 게이지·분모를 한 줄로 둔다.
  // 사람의 차례가 된 까닭은 접근 이름에 남기고, 보이는 줄은 결정 상태와 질문 수를 말한다.
  const decisionNote = row.decisionRequestedAt !== undefined && row.decisionNote ? resolveLocalizedText(row.decisionNote, locale) : "";
  // 맡은 이가 처리 중인 동안(`delegated`)은 그 상태 문구가 미리보기 자리를 차지하고 명도 물결로 흐른다 — 미리보기가 가려지는 것은 알고 고른 비용이다.
  const handlingStatus = row.decisionRequestedAt === undefined && row.delegated ? resolveLocalizedText(row.delegated.status, locale) : "";
  const conversationLine = handlingStatus || (row.decisionRequestedAt !== undefined
    ? `${t("commanderTab.status.awaiting")}${row.decisionQuestions ? ` ${row.decisionQuestions}` : ""}`
    : state === "review" ? t("commanderTab.status.review")
      : state in CONVERSATION_ROW_PHRASE ? t(CONVERSATION_ROW_PHRASE[state as keyof typeof CONVERSATION_ROW_PHRASE]) : label);
  // 이름 변경 — 칩과 같은 인라인 편집이다(F2·메뉴·제목 더블클릭). 제목은 플러그인의 것이라 확정은 `row.rename` 이 지고, 선언하지 않은 줄은 편집을 열지 않는다.
  const renameRow = row.rename;
  const rename = useInlineRename({ currentTitle: layout.cluster.title, onCommit: (next) => renameRow?.(next) });
  // 메뉴의 「이름 바꾸기」가 여는 통로 — 뿌리가 선 줄은 그 Objective id, 뿌리 없는 줄(시작 전 목표)은 줄 id 로 듣는다.
  const actionId = anchor?.objectiveRecord?.id ?? layout.cluster.id;
  useEffect(() => {
    if (!renameRow) return undefined;
    return subscribeSideBarObjectiveAction((request) => {
      if (request.objectiveId !== actionId || request.action !== "rename") return false;
      if (rowRef.current?.closest("[inert]")) return false;
      rename.begin();
      return true;
    });
  }, [renameRow, actionId, rename]);
  const renameInput = (
    <input
      className="side-bar-chip-rename-input side-bar-cluster-row-rename-input"
      ref={rename.inputRef}
      value={rename.draftTitle}
      aria-label={t("sidebar.chip.renameAria", { title: layout.cluster.title })}
      onChange={(e) => rename.setDraftTitle(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); rename.handleKeyDown(e); }}
      onKeyUp={(e) => e.stopPropagation()}
      onBlur={rename.handleBlur}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
  const meta: { readonly key: string; readonly text: string; readonly tone?: "req" | "late" | "from" | "accent" | "warn"; readonly prov?: true }[] = [];
  // 결정 수 — 사람이 답할 요청만 대기 신호로 칠한다. 맡은 이가 다루는 요청은 같은 자리에 무채색으로 선다.
  if (row.decisionRequestedAt !== undefined && row.decisionQuestions !== undefined) meta.push({ key: "req", text: t("sidebar.row.decisions", { n: row.decisionQuestions }), tone: "req" });
  else if (row.decisionRequestedAt === undefined && row.delegated) meta.push({ key: "req", text: t("sidebar.row.decisions", { n: row.delegated.questions }) }, { key: "handling", text: handlingStatus });
  if (decisionNote) meta.push({ key: "req-note", text: decisionNote });
  if (row.progress && row.progress.total > 0) meta.push({ key: "progress", text: `${row.progress.done}/${row.progress.total}` });
  if (row.due) meta.push({ key: "due", text: formatDue(row.due.date, locale), ...(row.due.overdue ? { tone: "late" as const } : {}) });
  if (row.followup) meta.push({ key: "from", text: row.followup.originTitle ? t("sidebar.row.followupOf", { title: row.followup.originTitle }) : t("sidebar.row.followup"), tone: "from" });
  row.provenance?.forEach((part, index) => {
    const text = resolveLocalizedText(part.text, locale);
    if (text) meta.push({ key: `prov-${index}`, text, prov: true, ...(part.tone ? { tone: part.tone } : {}) });
  });
  row.notes?.forEach((note, index) => {
    const text = resolveLocalizedText(note.text, locale);
    if (text) meta.push({ key: `note-${index}`, text, ...(note.tone ? { tone: note.tone } : {}) });
  });
  // 제목 끝에는 짧은 기한·주의 메모, 둘째 줄에는 상태·게이지·분모가 선다. 나머지 메타는 접근 이름이 보존한다.
  const progress = row.progress && row.progress.total > 0 ? row.progress : null;
  const headMeta = meta.flatMap((part) => (
    part.key === "due" && row.due ? [{ ...part, text: t("sidebar.row.dueShort", { date: formatDueShort(row.due.date) }) }]
      : part.key.startsWith("note-") && part.tone === "warn" ? [part]
        : []
  ));
  const rowRef = useRef<HTMLLIElement | null>(null);
  const pointerTypeRef = useRef("mouse");
  // 목표 줄은 세션 유무와 무관하게 옆 칸으로 간다. 목표가 아닌 사령관 질문만 기존 질문 카드를 연다.
  const open = () => {
    const objectiveId = commanderObjectiveId(layout.cluster);
    if (objectiveId === null) { layout.cluster.open?.(); return; }
    onFocus(objectiveId);
    if (anchor) registry.objectives.objectiveRecordSelected(anchor.objectiveRecord.id);
  };
  // 제목 글자 위 더블클릭은 이름 변경이다 — 제목 칸은 줄 폭으로 늘어나 있으므로 글자 자리로 판정한다. 이름 변경이면 dblclick 이
  // 버튼까지 번지지 않게 여기서 멈춘다. 터치의 더블 탭은 이름 변경으로 읽지 않는다.
  const renameOnTitleDoubleClick = renameRow
    ? (event: MouseEvent<HTMLSpanElement>) => {
      if (pointerTypeRef.current === "touch" || !pointOnText(event.currentTarget, event.clientX, event.clientY)) return;
      event.stopPropagation();
      rename.begin();
    }
    : undefined;
  const titleNode = <span className="side-bar-cluster-row-title" onDoubleClick={renameOnTitleDoubleClick}>{layout.cluster.title}</span>;
  const style = accentValue ? ({ "--user-accent": accentValue } as CSSProperties) : undefined;
  return (
    <li
      ref={rowRef}
      className={[
        "side-bar-cluster-row",
        consoleUseWrapClassName(wrap),
        active ? "side-bar-cluster-row--active" : "",
        "side-bar-cluster-row--conversation",
      ].filter(Boolean).join(" ")}
      data-cluster-row-id={layout.cluster.id}
      {...(anchor ? { "data-side-bar-chip-id": anchor.objectiveRecord.id } : {})}
      style={style}
      onPointerDown={(event) => { pointerTypeRef.current = event.pointerType; }}
    >
      {state === "review" && row.review ? (
        <button
          type="button"
          className="side-bar-cluster-row-glyph is-actionable"
          aria-label={label}
          title={label}
          onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); row.review!(locale); }}
        >
          <ClusterRowAvatar item={item} rowState={state} label={label} decorative />
        </button>
      ) : (
        <span className="side-bar-cluster-row-glyph">
          <ClusterRowAvatar item={item} rowState={state} label={label} />
        </span>
      )}
      <button
        type="button"
        className="side-bar-cluster-row-main"
        aria-current={active ? "true" : undefined}
        aria-description={wrap ? t("sidebar.chip.gaze", { caller: gestureCallerLabel(wrap.gesture.caller), summary: wrap.gesture.summary }) : undefined}
        aria-label={[layout.cluster.title, label, ...meta.map((part) => part.text), row.mark && !row.mark.toggle ? resolveLocalizedText(row.mark.label, locale) : ""].filter(Boolean).join(", ")}
        onClick={open}
        onKeyDown={(event) => {
          if (renameRow && event.key === "F2") {
            event.preventDefault();
            rename.begin();
          }
        }}
      >
        <span className="side-bar-cluster-row-head">
            {rename.renaming ? renameInput : titleNode}
            {headMeta.map((part) => (
              <span key={part.key} className={["side-bar-cluster-row-lead", part.tone ? `is-${part.tone}` : ""].filter(Boolean).join(" ")} aria-hidden="true">{part.text}</span>
            ))}
        </span>
        <span className="side-bar-cluster-row-line" aria-hidden="true">
          <span className={["side-bar-chip-preview side-bar-cluster-row-preview", `is-${row.decisionRequestedAt !== undefined ? "awaiting" : state}`, handlingStatus ? "is-handling" : ""].filter(Boolean).join(" ")}>{conversationLine}</span>
          {progress ? <>
            <span className={`side-bar-cluster-row-gauge${progress.done >= progress.total ? " is-complete" : ""}`}><span style={{ width: `${Math.max(0, Math.min(100, progress.done / progress.total * 100))}%` }} /></span>
            <span className="side-bar-cluster-row-fraction">{progress.done}/{progress.total}</span>
          </> : null}
        </span>
      </button>
      {/* 표식이 토글이면 칸 안에 버튼이 서므로 칸 전체를 숨기지 않는다 — 장식인 표식만 숨긴다. */}
      <span className="side-bar-cluster-row-aside" {...(row.mark?.toggle ? {} : { "aria-hidden": true })}>
        {row.mark ? (row.mark.toggle ? <ClusterRowMarkToggle mark={row.mark} toggle={row.mark.toggle} /> : <ClusterRowMark mark={row.mark} />) : null}
      </span>
    </li>
  );
}

/**
 * 줄 앞 표식 — 지휘관 아바타와, 지금 일하는(진행·부름·안 본 답) 구성원 미니 아바타 최대 셋. 지휘관의 얼굴은 자기 상태를 말하고
 * (플러그인 글리프·결정 요청이 있으면 그것), 미니가 누가 함께 일하는지 말한다. 접근성 이름은 줄의 가장 급한 상태 하나다.
 */
function ClusterRowAvatar({ item, rowState, label, decorative = false }: {
  readonly item: SideBarRowItem;
  readonly rowState: ObjectiveClusterRowGlyph | ObjectiveMarkVisual;
  readonly label: string;
  readonly decorative?: boolean;
}) {
  const { row, anchor, layout } = item;
  // 지휘관의 얼굴은 다른 표면과 같은 기준(`mongleStateOf`)을 지난다 — 줄의 글리프는 시작 전·검토 대기·완료라는 사실로,
  // 활동은 뿌리 칩의 표식(구성원 활동을 끌어올린 공개 축, 안 본 답 포함)으로 넘긴다. 뿌리가 없으면 줄의 가장 급한 표식이다.
  const commanderState: MongleState = mongleStateOfMark(anchor ? anchor.mark ?? anchor.status : row.glyph ? undefined : rowState as ObjectiveMarkVisual, {
    session: row.glyph !== "fresh",
    awaitingReview: row.glyph === "review",
    decisionRequest: row.decisionRequestedAt !== undefined,
    workDone: row.glyph === "done",
  });
  // 미니는 그 줄 지휘관의 실제 구성원만 — `fold` 에는 뿌리(지휘관) 자신이 함께 들 수 있고 구성원은 사이드바 목록에 없을 수 있으므로,
  // 묶음의 구성원 목록에서 뿌리를 빼고 상태는 사이드바 표식(있으면)과 런타임 활동에서 읽는다. 구성원이 없는 줄(단독 Objective)은
  // 미니 없이 제 크기로 선다.
  const { objectiveRecords, nestedObjectiveRecords, objectiveRecordRuntime } = useConsoleState();
  const foldMarks = new Map(item.fold.map((entry) => [entry.objectiveRecord.id, entry.mark ?? entry.status ?? "idle"] as const));
  const working = clusterWorkingMembers(layout.cluster, anchor?.objectiveRecord?.id ?? layout.cluster.root, { objectiveRecords, nestedObjectiveRecords, objectiveRecordRuntime }, foldMarks);
  // 대화 행의 지휘관 아바타는 30px 이다 — 제목·진행 두 줄을 함께 받친다. 일반 Objective 칩(22px)은 그대로다.
  const full = 30;
  const size = working.length > 0 ? 26 : full;
  // 사령관이 직접 묻는 줄은 그 Theater 사령관의 얼굴로 선다 — 지휘관 묶음이 아니다.
  const commander = row.commodore && !anchor
    ? <KeyedAvatar avatarKey={theaterAvatarKey(layout.cluster.theaterId)} role="commodore" state={commanderState} size={size} label={label} decorative={decorative} />
    : anchor
    ? <ObjectiveAvatar objectiveRecord={anchor.objectiveRecord} role="commander" state={commanderState} size={size} label={label} decorative={decorative} />
    : <KeyedAvatar avatarKey={objectiveRecordAvatarKey(layout.cluster.root ?? layout.cluster.avatarObjectiveId ?? layout.cluster.id)} role="commander" state={commanderState} activityObjectiveId={layout.cluster.root} size={size} label={label} decorative={decorative} />;
  if (working.length === 0) return commander;
  return (
    <span className="side-bar-cluster-avatars" style={{ width: full, height: full }}>
      {commander}
      <span className="side-bar-cluster-avatars-minis" aria-hidden="true">
        {working.map((entry) => (
          <span key={entry.objectiveRecord.id} className="side-bar-cluster-avatars-mini">
            <ObjectiveAvatar objectiveRecord={entry.objectiveRecord} role="member" state={mongleStateOfMark(entry.mark)} size={14} label="" decorative />
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * 줄 오른쪽 끝의 표식 — 플러그인이 정한 맡은 이가 다루는 줄. 켬·끔은 맡은 이가 돌고 있는지(스위치)이고, 맡은 이의 줄에 머무는
 * 동안은 같은 표식들이 함께 밝아진다. 플러그인이 맡은 이의 글리프를 주면 그 모양을 같은 잉크 규칙으로 칠하고, 없으면 사각을
 * 그린다. 뜻은 줄의 접근 이름이 말하므로 여기서는 제목만 단다. 「확인 필요」 목록의 줄도 같은 표식을 쓴다.
 */
export function ClusterRowMark({ mark, decorative = true }: { readonly mark: ObjectiveClusterRowMark; readonly decorative?: boolean }) {
  const locale = useConsoleLocale();
  const label = resolveLocalizedText(mark.label, locale);
  const glyph = mark.renderGlyph?.();
  const className = ["side-bar-cluster-row-mark", glyph ? "has-glyph" : "", `is-${mark.square}`, mark.emphasized ? "is-emphasized" : ""].filter(Boolean).join(" ");
  // 누르는 표식의 라벨은 그 누름을 안내한다 — 누를 수 없는 장식으로 설 때는 제목을 달지 않는다.
  return <i className={className} {...(mark.toggle ? {} : { title: label })} {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}>{glyph}</i>;
}

/**
 * 누르는 표식 — 표식 자체가 맡김 스위치다(줄 본문 다음의 초점 자리). 켬·끔은 `aria-pressed` 가 말하고 접근 이름은 바뀌지 않는다.
 * 꺼진 표식은 줄에 올리거나 초점이 올 때만 보인다(터치는 흐리게 늘). 줄은 누르는 순간 끌기를 시작하므로 여기서 막고, 누르고 있는
 * Enter·Space 의 반복 입력과 더블클릭의 둘째 클릭은 받지 않는다 — 한 번 누름이 한 번 바꿈이다.
 */
function ClusterRowMarkToggle({ mark, toggle }: { readonly mark: ObjectiveClusterRowMark; readonly toggle: NonNullable<ObjectiveClusterRowMark["toggle"]> }) {
  const locale = useConsoleLocale();
  const glyph = mark.renderGlyph?.();
  const className = ["side-bar-cluster-row-mark", glyph ? "has-glyph" : "", toggle.pressed ? `is-${mark.square}` : "is-off", toggle.pressed && mark.emphasized ? "is-emphasized" : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={`side-bar-cluster-row-mark-toggle${toggle.pressed ? " is-pressed" : ""}`}
      aria-pressed={toggle.pressed}
      aria-label={resolveLocalizedText(toggle.label, locale)}
      title={resolveLocalizedText(mark.label, locale)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail > 1) return;
        toggle.onToggle(locale);
      }}
      onKeyDown={(event) => {
        // 상위 키 처리기가 버튼의 기본 활성화를 취소하지 않게 한다(시작 전 묶음 버튼과 같은 규칙).
        if (event.code === "Space") event.stopPropagation();
        if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
      }}
    >
      <i className={className} aria-hidden="true">{glyph}</i>
    </button>
  );
}
