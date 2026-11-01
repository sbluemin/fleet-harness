import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "../../../workspace/shared/conversation-surfaces.js";
import type { ConversationParticipant, ConversationSpeaker } from "../../../execution/shared/conversation/types.js";
import type { AgentConversationEntry, AgentConversationProps } from "../../../execution/shared/chat-renderer.js";
import { MAX_TASKFORCE_MEMBERS, MAX_TASKFORCE_NAME, MAX_TASKFORCE_TOPIC, MAX_TASKFORCE_IMAGES, MAX_TASKFORCE_IMAGE_BYTES, TASKFORCE_ROUTE_NAMES, type TaskforceAction, type TaskforceLedgerEntry } from "../../shared/contracts/taskforce.js";
import { commodoreAvatarKey } from "../../../workspace/shared/avatars.js";
import { mongleBase } from "../../../workspace/shared/avatars.js";
import { useAvatarBook, resolveMongleLook } from "../../../workspace/client/avatar-events.js";
import { useConversationSurface } from "../../../workspace/client/conversation/conversation-surface-store.js";
import { GroupContextMenu } from "../../../workspace/client/sidebar/group-context-menu.js";
import { CommodoreSectionMoveMenu, useCommodoreSidebarSections } from "../../../workspace/client/sidebar/commodore-sidebar-sections.js";
import { TrashIcon } from "../../../workspace/client/sidebar/sidebar-menu-icons.js";
import { useContextMenuKeyboard } from "../../../workspace/client/sidebar/context-menu-keyboard.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { CommodoreAvatar } from "../commodore-avatar.js";
import { actionWord } from "../commodore-chat.js";
import { getT as getCommodoreT } from "../i18n/index.js";
import { commodoreSectionLabel, readCommodoreList, subscribeCommodoreList, useCommodoreList } from "../commodore-list.js";
import { openCommodoreConversation } from "../commodore-conversation.js";
import { attachToCommodoreComposer, CommodoreComposer } from "../commodore-inbox-section.js";
import { commodoreConversationRenderer } from "../commodore-state.js";
import { openReferencedObjective } from "../commodore-reference-input.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "../../shared/contracts/attachment-budget.js";
import { CONVERSATION_REFERENCE_MARK } from "../../../execution/shared/conversation/references.js";
import { MentionChip } from "../../../execution/client/composer-primitives/mention-chip.js";
import { MobileIcon } from "../../../../core/client/src/chrome/mobile/mobile-icons.js";
import { MobileSheet } from "../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushBackLayer } from "../../../../core/client/src/chrome/mobile/mobile-back.js";
import { pushOverlayHistory, releaseOverlayHistory } from "../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { taskforceT } from "./i18n.js";
import { MemberPicker } from "./member-picker.js";
import { loadTaskforce, loadTaskforceActions, mutateTaskforce, readTaskforce, readTaskforceExperiment, readTaskforces, subscribeTaskforces, useTaskforce, useTaskforceExperiment, useTaskforces, wasTaskforceRemoved } from "./state.js";
import "./taskforce.css";

const SURFACE = "taskforce";
/** 좌측 목록이 TF 행을 사령관 행과 같은 자리에 세울 때 쓰는 표면 id. */
export const TASKFORCE_SURFACE_ID = SURFACE;
let conversation: ClientConversationCapability | undefined;
let createRequest: { readonly preselected?: string } | null = null;
/** 삭제 확인 — 우클릭 메뉴는 항목을 누르면 먼저 닫히므로 확인 대화상자는 메뉴 밖 호스트가 띄운다. */
let deleteRequest: string | null = null;
let mobileId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function connectTaskforceConversation(port: ClientConversationCapability | undefined): () => void {
  conversation = port;
  return () => { if (conversation === port) conversation = undefined; };
}
export function requestTaskforceCreate(preselected?: string): void {
  // 실험이 꺼져 있으면 만들지 않는다 — 보이는 입구는 숨고, 남은 요청 경로는 여기서 막힌다.
  const experiment = readTaskforceExperiment();
  if (experiment.known && !experiment.enabled) return;
  createRequest = { ...(preselected ? { preselected } : {}) }; emit();
}
export function requestTaskforceDelete(id: string): void { deleteRequest = id; emit(); }
export function openTaskforce(id: string): void {
  if (!conversation?.open(SURFACE, { taskforceId: id })) { mobileId = id; emit(); }
  void loadTaskforce(id);
}
/**
 * 공용 컴포저(사령관 입력창)의 TF 첨부 포트 — 사령관 채팅과 같은 붙여넣기·드롭·첨부 버튼 길로 들어와 post 때 base64로 실린다.
 * 저장 위치·크기 제한은 사령관 채팅의 기존 규칙을 재사용한다: 한 번에 4장, 장당 8 MiB, png/jpeg/gif/webp.
 */
const TF_ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const taskforceImagePayloads = new Map<string, { readonly name: string; readonly mime: string; readonly dataBase64: string }>();
const fileToBase64 = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const url = typeof reader.result === "string" ? reader.result : "";
    const comma = url.indexOf(",");
    if (!comma) { reject(new Error("attachment_failed")); return; }
    resolve(url.slice(comma + 1));
  };
  reader.onerror = () => reject(new Error("attachment_failed"));
  reader.readAsDataURL(file);
});
const taskforceAttachmentPort = () => ({
  upload: async (file: Blob) => {
    const mime = file.type;
    if (!TF_ALLOWED_MIMES.has(mime)) throw new Error("attachment_unsupported");
    if (file.size > MAX_TASKFORCE_IMAGE_BYTES) throw new Error("attachment_too_large");
    const dataBase64 = await fileToBase64(file);
    if (dataBase64.length > 16 * 1024 * 1024) throw new Error("attachment_too_large");
    const id = crypto.randomUUID();
    const name = file instanceof File && file.name.trim() ? file.name : "pasted image";
    taskforceImagePayloads.set(id, { name, mime, dataBase64 });
    return { id };
  },
  discard: async (id: string) => { taskforceImagePayloads.delete(id); },
});
const memberName = (id: string, language: string) => {
  const row = readCommodoreList().find((row) => row.commodoreId === id);
  return row ? commodoreSectionLabel(row, language === "ko" ? "사령관" : "Commodore") : language === "ko" ? "사령관" : "Commodore";
};

export function TaskforceStack({ members }: { readonly members: readonly string[]; readonly judging?: readonly string[] }) {
  const shown = members.slice(0, 4);
  return <span className="taskforce-stack" data-count={shown.length} aria-hidden="true">{shown.map((id) => <CommodoreAvatar key={id} commodoreId={id} state="idle" size={18} label="" decorative />)}</span>;
}

/**
 * TF 행의 우클릭 메뉴 — 사령관 행과 같은 자리에 서고, 삭제에 더해 사용자 섹션
 * 소속(섹션 사이 이동·새 섹션)도 같은 섹션 메뉴로 바꾼다. 행 자체는 사이드바가 그린다.
 */
export function TaskforceRowMenu({ id, anchor, focusFirst, returnFocus, onClose }: {
  readonly id: string;
  readonly anchor: DOMRect;
  readonly focusFirst?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const language = useConsoleLocale();
  const t = taskforceT(language);
  const snapshot = useTaskforce(id);
  // 원장을 아직 읽지 않은 행도 메뉴가 서도록 목록 요약의 이름을 쓴다(삭제·섹션 이동에 원장은 필요 없다).
  const summary = useTaskforces().find((row) => row.id === id);
  const name = snapshot.state?.name ?? summary?.name;
  const sections = useCommodoreSidebarSections();
  const returnFocusRef = useRef(returnFocus ?? null);
  returnFocusRef.current = returnFocus ?? null;
  useContextMenuKeyboard({ open: true, menuSelector: '.group-context-menu-card[role="menu"]', returnFocusRef, focusFirst, onEscape: onClose });
  if (!name) return null;
  return <GroupContextMenu kind="actions" anchor={anchor} label={name} items={[]} footer={<><CommodoreSectionMoveMenu rowId={id} controller={sections} onClose={onClose} /><div className="group-context-menu-divider" role="separator" /><button type="button" role="menuitem" className="group-context-menu-item group-context-menu-item--danger" onClick={() => { onClose(); requestTaskforceDelete(id); }}><span className="group-context-menu-item__glyph" aria-hidden="true"><TrashIcon /></span><span className="group-context-menu-item__name">{t("taskforce.delete")}</span></button></>} onClose={onClose} />;
}

function DeleteDialog({ id, language, onClose }: { readonly id: string; readonly language: "ko" | "en"; readonly onClose: () => void }) {
  const t = taskforceT(language);
  const snapshot = useTaskforce(id);
  const rows = useTaskforces();
  const name = snapshot.state?.name ?? rows.find((row) => row.id === id)?.name ?? "";
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const remove = async () => {
    if (busy) return; setBusy(true); setFailed(false);
    try { await mutateTaskforce("delete", { taskforceId: id }); onClose(); }
    catch { setFailed(true); } finally { setBusy(false); }
  };
  return <Dialog title={t("taskforce.deleteTitle")} onClose={() => { if (!busy) onClose(); }}><div className="taskforce-dialog-body"><p>{t("taskforce.deleteWarning", { name })}</p>{failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}</div><footer><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={onClose}>{t("taskforce.cancel")}</button><button type="button" className="fc-btn taskforce-danger" disabled={busy} onClick={() => void remove()}>{t("taskforce.deleteConfirm")}</button></footer></Dialog>;
}

function Dialog({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const language = useConsoleLocale();
  useEffect(() => {
    const previous = document.activeElement;
    const root = ref.current;
    root?.querySelector<HTMLElement>("textarea, input, button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab" || !root) return;
      const nodes = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
      const first = nodes[0]; const last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    root?.addEventListener("keydown", keydown);
    return () => { root?.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="taskforce-scrim" role="presentation" onPointerDown={onClose}><div ref={ref} className="taskforce-dialog" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(event) => event.stopPropagation()}>
    <header><h2>{title}</h2><button type="button" className="taskforce-close" onClick={onClose} aria-label={taskforceT(language)("taskforce.closeDialog")}>×</button></header>{children}
  </div></div>, document.body);
}

function CreateDialog({ preselected, onClose }: { readonly preselected?: string; readonly onClose: () => void }) {
  const language = useConsoleLocale(); const t = taskforceT(language);
  const commodores = useCommodoreList();
  const [topic, setTopic] = useState(""); const [name, setName] = useState(""); const [editedName, setEditedName] = useState(false);
  const [members, setMembers] = useState<readonly string[]>(preselected ? [preselected] : []);
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const currentMembers = members.filter((id) => commodores.some((row) => row.commodoreId === id));
  const candidates = useMemo(() => commodores.filter((row) => !currentMembers.includes(row.commodoreId)).map((row) => ({ id: row.commodoreId, name: memberName(row.commodoreId, language) })), [commodores, currentMembers, language]);
  const reason = !topic.trim() ? t("taskforce.topicRequired") : !name.trim() ? t("taskforce.nameRequired") : currentMembers.length < 2 ? t("taskforce.minimum") : null;
  const submit = async () => {
    if (busy || !topic.trim() || !name.trim() || currentMembers.length < 2) return;
    setBusy(true); setFailed(false);
    try {
      const state = await mutateTaskforce("create", { topic: topic.trim(), name: name.trim(), members: currentMembers });
      if (state) { onClose(); openTaskforce(state.id); }
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <Dialog title={t("taskforce.createTitle")} onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="taskforce-dialog-body">
      <label>{t("taskforce.topic")}<textarea required maxLength={MAX_TASKFORCE_TOPIC} rows={3} value={topic} placeholder={t("taskforce.topicPlaceholder")} onChange={(event) => { const value = event.target.value; setTopic(value); if (!editedName) setName(value.trim().split("\n")[0]!.slice(0, MAX_TASKFORCE_NAME)); }} /></label>
      <fieldset><legend>{t("taskforce.members")}</legend>
        {currentMembers.length ? <div className="taskforce-picked">{currentMembers.map((id) => <div className="taskforce-member" key={id}><span className="taskforce-member-picked"><CommodoreAvatar commodoreId={id} state="idle" size={28} label="" decorative /><strong>{memberName(id, language)}</strong></span><button type="button" className="taskforce-text-button taskforce-member-remove" disabled={busy} onClick={() => setMembers(currentMembers.filter((member) => member !== id))}>{t("taskforce.remove")}</button></div>)}</div> : null}
        <button ref={addRef} type="button" className="commodore-theaters-add" disabled={busy || currentMembers.length >= MAX_TASKFORCE_MEMBERS} aria-expanded={picking} onClick={() => setPicking(!picking)}><span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span><span>{t("taskforce.add")}</span></button>
        {picking ? <MemberPicker anchor={addRef.current} candidates={candidates} searchPlaceholder={t("taskforce.searchCommodores")} emptyText={t("taskforce.noMatchingCommodores")} listLabel={t("taskforce.members")} onPick={(id) => { if (currentMembers.length < MAX_TASKFORCE_MEMBERS) setMembers([...currentMembers, id]); }} onClose={() => setPicking(false)} /> : null}
      </fieldset>
      <label>{t("taskforce.name")}<input required maxLength={MAX_TASKFORCE_NAME} value={name} placeholder={t("taskforce.namePlaceholder")} onChange={(event) => { setEditedName(true); setName(event.target.value); }} /></label>
      {failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}
    </div><footer><span /><span><button type="button" className="fc-btn fc-btn--secondary" onClick={onClose} disabled={busy}>{t("taskforce.cancel")}</button><span className="taskforce-create-tip" tabIndex={reason ? 0 : undefined} aria-describedby={reason ? "taskforce-create-reason" : undefined}><button type="submit" className="fc-btn fc-btn--primary" disabled={busy || reason !== null}>{t("taskforce.create")}</button>{reason ? <span id="taskforce-create-reason" role="tooltip">{reason}</span> : null}</span></span></footer>
  </form></Dialog>;
}

export function TaskforceHost() {
  const request = useSyncExternalStore(subscribe, () => createRequest);
  const deleting = useSyncExternalStore(subscribe, () => deleteRequest);
  const mobile = useSyncExternalStore(subscribe, () => mobileId);
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const rows = useTaskforces();
  const selection = useConversationSurface();
  const experiment = useTaskforceExperiment();
  useEffect(() => {
    if (selection?.surfaceId === SURFACE && wasTaskforceRemoved(idOf(selection.params))) conversation?.close(SURFACE);
    if (mobile && wasTaskforceRemoved(mobile)) { mobileId = null; emit(); }
  }, [rows, selection, mobile]);
  // 실험이 꺼지면 열려 있던 TF 대화·화면을 닫는다. 저장된 TF와 읽음 커서는 그대로 둔다.
  useEffect(() => {
    if (!experiment.known || experiment.enabled) return;
    createRequest = null;
    deleteRequest = null;
    if (selection?.surfaceId === SURFACE) conversation?.close(SURFACE);
    if (mobileId) { mobileId = null; }
    emit();
  }, [experiment.known, experiment.enabled, selection]);
  if (!experiment.enabled && experiment.known) return null;
  return <>{request ? <CreateDialog {...request} onClose={() => { createRequest = null; emit(); }} /> : null}{deleting ? <DeleteDialog key={deleting} id={deleting} language={language} onClose={() => { deleteRequest = null; emit(); }} /> : null}{mobile ? <TaskforceMobileScreen id={mobile} language={language} onClose={() => { mobileId = null; emit(); }} /> : null}</>;
}

function TaskforceActions({ actions, commodoreId, language }: { readonly actions: readonly TaskforceAction[]; readonly commodoreId?: string; readonly language: string }) {
  return <div className="taskforce-action-list">{actions.map((action, index) => <div key={`${action.objectiveId}:${index}`} className="taskforce-action"><span className="taskforce-action-kind">{actionWord(getCommodoreT(language === "ko" ? "ko" : "en"), action.kind)}</span><button type="button" className="taskforce-link" onClick={() => { if (commodoreId) openReferencedObjective(commodoreId, action.objectiveId); }} disabled={!commodoreId}>{action.title || action.objectiveId}</button></div>)}</div>;
}

/**
 * 본문 속 지목 — 사령관 1:1 말풍선의 참조 토큰과 같은 표시(공용 MentionChip)다. 중립 면이라
 * 사람 말풍선(분홍)에서도 본문색을 이어받고, 문장 흐름 안에 인라인으로 선다. 짝 없는
 * 지목(원문에 `@이름`이 없는 것)은 1:1과 같이 그리지 않는다.
 */
function MentionText({ entry, language, speaker }: { readonly entry: TaskforceLedgerEntry; readonly language: string; readonly speaker: (id: string) => ConversationSpeaker }) {
  const pattern = entry.mentions.map((id) => ({ id, token: `@${memberName(id, language)}` })).sort((a, b) => b.token.length - a.token.length);
  const parts: ReactNode[] = [];
  let text = entry.text;
  while (text) {
    let match: { id: string; token: string; at: number } | undefined;
    for (const member of pattern) { const at = text.indexOf(member.token); if (at >= 0 && (!match || at < match.at)) match = { ...member, at }; }
    if (!match) { parts.push(text); break; }
    const person = speaker(match.id);
    parts.push(text.slice(0, match.at), <MentionChip key={parts.length} label={memberName(match.id, language)} mark={<CommodoreAvatar commodoreId={match.id} state="idle" size={16} label="" decorative />} tone={person.mark?.tone ?? null} />);
    text = text.slice(match.at + match.token.length);
  }
  return <span className="taskforce-message-text">{parts}</span>;
}

// 폰 화면: 대화가 화면 전체를 쓰고, 머리(‹ · 제목 알약 · ⓘ)는 위에 떠 있으며, 개요·멤버 같은 상세는 ⓘ 시트가 연다.
function TaskforceMobileScreen({ id, language, onClose }: { readonly id: string; readonly language: "ko" | "en"; readonly onClose: () => void }) {
  const t = taskforceT(language);
  const [details, setDetails] = useState(false);
  // 이 화면은 앱 틀의 시트 호스트(z-index 50대)보다 위에 서므로 시트를 호스트로 열 수 없다 — 하드웨어·브라우저 뒤로가 TaskForce 화면보다
  // 시트를 먼저 닫도록 열려 있는 동안만 뒤로 겹침과 history 항목을 올린다(결과 창과 같은 계약).
  useEffect(() => {
    if (!details) return;
    let historyId: number | null = pushOverlayHistory(() => { historyId = null; setDetails(false); });
    const releaseLayer = pushBackLayer(() => setDetails(false));
    return () => {
      releaseLayer();
      if (historyId !== null) releaseOverlayHistory(historyId);
    };
  }, [details]);
  return <div className="taskforce-mobile-screen">
    <header>
      <button type="button" className="mobile-bar-button" aria-label={t("taskforce.closeDialog")} onClick={onClose}><MobileIcon name="back" /></button>
      <div className="mobile-conv-pill"><span className="mobile-conv-pill-copy"><strong>{readTaskforce(id).state?.name}</strong></span></div>
      <button type="button" className="mobile-bar-button" aria-label={t("taskforce.overview")} aria-haspopup="dialog" onClick={() => setDetails(true)}><MobileIcon name="info" /></button>
    </header>
    <TaskforceBody key={id} id={id} language={language} />
    {details ? <MobileSheet title={t("taskforce.overview")} onClose={() => setDetails(false)}><TaskforceDetails id={id} tab="overview" language={language} /></MobileSheet> : null}
  </div>;
}

function TaskforceBody({ id, language }: { readonly id: string; readonly language: "ko" | "en" }) {
  const t = taskforceT(language);
  const snapshot = useTaskforce(id); const { state, entries, judging } = snapshot;
  const commodores = useCommodoreList();
  const book = useAvatarBook();
  const [failure, setFailure] = useState(false); const [busy, setBusy] = useState(false); const [older, setOlder] = useState(false);
  useEffect(() => { void loadTaskforce(id); }, [id]);
  const bySeq = useMemo(() => new Map(entries.map((entry) => [entry.seq, entry])), [entries]);
  const actionsByReply = useMemo(() => {
    const grouped = new Map<number, TaskforceAction[]>();
    for (const entry of entries) if (entry.replyTo !== undefined && entry.actions?.length) grouped.set(entry.replyTo, [...(grouped.get(entry.replyTo) ?? []), ...entry.actions]);
    return grouped;
  }, [entries]);
  const speaker = (commodoreId: string): ConversationSpeaker => { const look = resolveMongleLook(book, commodoreAvatarKey(commodoreId)); return { kind: "commodore", commodoreId, name: memberName(commodoreId, language), mark: { number: 0, tone: look.tone ?? mongleBase(look.base).tone } }; };
  const items = useMemo<readonly AgentConversationEntry[]>(() => entries.flatMap((entry): AgentConversationEntry[] => {
    if (entry.actions?.length && entry.replyTo !== undefined && bySeq.has(entry.replyTo)) return [];
    if (entry.actions?.length && entry.speaker.kind === "commodore") {
      const owner = speaker(entry.speaker.commodoreId);
      return entry.actions.map((action, index) => ({ kind: "board-action", id: `${entry.seq}:${index}`, at: entry.at, speaker: owner, objectiveId: action.objectiveId, action: actionWord(getCommodoreT(language), action.kind), text: "", target: { id: action.objectiveId, label: action.title } }));
    }
    if (entry.speaker.kind === "system") return [{ kind: "note", id: String(entry.seq), at: entry.at, text: t(`taskforce.system.${entry.speaker.code}`, { text: entry.text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => memberName(id, language)) }), ...(entry.speaker.code === "chain-paused" ? { tone: "warn" as const } : {}) }];
    return [{ kind: "message", id: String(entry.seq), at: entry.at, objectiveId: id, speaker: entry.speaker.kind === "person" ? { kind: "human", name: "" } : speaker(entry.speaker.commodoreId), text: entry.text || (entry.actions?.length ? " " : ""), streaming: false,
      ...(entry.images?.length ? { attachments: entry.images.map((image) => ({ preview: { id: image.id, url: `/api/v1/${TASKFORCE_ROUTE_NAMES.image}?${new URLSearchParams({ taskforceId: id, seq: String(entry.seq), imageId: image.id })}` } })) } : {}) }];
  }), [entries, id, language, book, commodores, bySeq]);
  const participants: readonly ConversationParticipant[] = [...new Set([...(state?.members ?? []), ...entries.flatMap((entry) => entry.speaker.kind === "commodore" ? [entry.speaker.commodoreId] : [])])].map((id) => ({ speaker: speaker(id), activity: judging.includes(id) ? "running" : "idle" }));
  const run = async (route: "continue") => { if (busy) return; setBusy(true); setFailure(false); try { await mutateTaskforce(route, { taskforceId: id }); } catch { setFailure(true); } finally { setBusy(false); } };
  const Conversation = commodoreConversationRenderer();
  const messageContent: AgentConversationProps["messageContent"] = (message) => {
    const entry = bySeq.get(Number(message.id)); if (!entry) return;
    const actions = [...(entry.actions ?? []), ...(actionsByReply.get(entry.seq) ?? [])];
    const owner = entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined;
    return { ...(entry.mentions.length ? { body: <MentionText entry={entry} language={language} speaker={speaker} /> } : {}), ...(actions.length ? { footer: <TaskforceActions actions={actions} {...(owner ? { commodoreId: owner } : {})} language={language} /> } : {}) };
  };
  const cards = <>{state && state.chain.paused ? <div className="taskforce-paused"><span aria-hidden="true">Ⅱ</span><div><strong>{t("taskforce.paused", { n: state.chain.count })}</strong><small>{t("taskforce.pausedHint")}</small></div><span><button type="button" className="fc-btn fc-btn--primary" disabled={busy} onClick={() => void run("continue")}>{t("taskforce.continue")}</button></span></div> : null}</>;
  // 판단 중 표시는 사령관 1:1 채팅과 같은 자리·형태(대화 독의 working 줄)로 낸다. 별도 cards 줄을 세우지 않는다.
  const working = useMemo(() => judging.map((member) => speaker(member)), [judging, book, language, state?.members]);
  const port = useMemo(() => taskforceAttachmentPort(), [id]);
  const composerT = getCommodoreT(language);
  // 자리표는 사령관 입력과 같은 성격(상태·대상 정보, 사용법 설명 없음) — 판단할 성원 이름을 " · "로 잇는다.
  const composerPlaceholder = state ? state.members.map((id) => memberName(id, language)).join(" · ") : "";
  const composer = <div className="taskforce-foot">{failure || snapshot.error ? <p className="taskforce-error" role="alert">{t("taskforce.failed")} {snapshot.error ? <button type="button" className="taskforce-link" onClick={() => void loadTaskforce(id)}>{t("taskforce.retry")}</button> : null}</p> : null}
    {state ? <CommodoreComposer t={composerT} theaterId={state.id} active placeholder={composerPlaceholder} ariaLabel={t("taskforce.aria.composer")} allowedCommodoreIds={state.members} attachmentPort={port} attachmentLimits={{ max: MAX_TASKFORCE_IMAGES, bytes: MAX_TASKFORCE_IMAGE_BYTES }} sender={async ({ text, attachmentIds, references }) => {
      const mentions = references.flatMap((reference) => typeof reference === "string" ? [] : reference.kind === "commodore" && state.members.includes(reference.id) ? [reference.id] : []);
      const images = attachmentIds.flatMap((imageId) => {
        const payload = taskforceImagePayloads.get(imageId);
        return payload ? [{ name: payload.name, mime: payload.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", dataBase64: payload.dataBase64 }] : [];
      });
      // 한 발언의 이미지 합계는 사령관 1:1 메시지와 같은 상한이다 — host가 거절하기 전에 같은 안내로 막는다.
      const imageBytes = images.reduce((total, image) => total + Math.floor(image.dataBase64.length * 3 / 4), 0);
      if (imageBytes > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) throw new Error("attachment_budget_exceeded");
      // 공용 입력은 지목 자리에 자리표시 문자를 둔다 — 원장에는 사람이 읽는 「@이름」으로 남긴다(말풍선이 같은 자리에 칩을 세운다).
      let referenceIndex = 0;
      const plain = text.replace(new RegExp(CONVERSATION_REFERENCE_MARK, "g"), () => {
        const reference = references[referenceIndex++];
        return reference && typeof reference !== "string" && reference.kind === "commodore" ? `@${memberName(reference.id, language)}` : "";
      }).trim();
      await mutateTaskforce("post", { taskforceId: state.id, text: plain, ...(mentions.length ? { mentions } : {}), ...(images.length ? { images } : {}) });
      for (const imageId of attachmentIds) taskforceImagePayloads.delete(imageId);
    }} onFail={() => setFailure(true)} onClear={() => setFailure(false)} /> : null}</div>;
  return <div className="taskforce-conversation">{Conversation ? <Conversation entries={items} participants={participants} working={working} language={language} accessibleNames={{ log: t("taskforce.aria.log"), composer: t("taskforce.aria.composer") }} loading={!snapshot.loaded && !snapshot.error} empty={snapshot.error ? t("taskforce.failed") : t("taskforce.empty")} messageContent={messageContent} openBoardAction={{ label: t("taskforce.openNotice"), open: (entry) => { if (entry.speaker.commodoreId) openReferencedObjective(entry.speaker.commodoreId, entry.objectiveId); } }} older={snapshot.hasMore ? { label: t("taskforce.older"), loading: older, load: () => { setOlder(true); void loadTaskforce(id, true).finally(() => setOlder(false)); } } : null} cards={cards} composer={composer} composerTopEntries /> : <>{t("taskforce.loading")}{composer}</>}</div>;
}

type Tab = "overview" | "members" | "actions";
function TaskforceDetails({ id, tab, language }: { readonly id: string; readonly tab: Tab; readonly language: "ko" | "en" }) {
  const t = taskforceT(language); const snapshot = useTaskforce(id); const { state, judging } = snapshot;
  const commodores = useCommodoreList(); const [topic, setTopic] = useState(""); const [editingTopic, setEditingTopic] = useState(false); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const [removing, setRemoving] = useState<string | null>(null); const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const topicBase = useRef(""); const topicPreview = useRef<HTMLButtonElement>(null);
  const closeTopic = () => { setEditingTopic(false); window.requestAnimationFrame(() => topicPreview.current?.focus({ preventScroll: true })); };
  useEffect(() => { void loadTaskforce(id); }, [id]);
  useEffect(() => { const before = topicBase.current; const next = state?.topic ?? ""; topicBase.current = next; setTopic((current) => current === before ? next : current); }, [state?.topic]);
  useEffect(() => { if (tab === "actions") void loadTaskforceActions(id); }, [id, tab]);
  const run = async (route: "update" | "addMembers" | "removeMembers", body: object = {}) => {
    if (busy) return; setBusy(true); setFailed(false);
    try { await mutateTaskforce(route, { taskforceId: id, ...body }); if (route === "update") closeTopic(); setRemoving(null); }
    catch { setFailed(true); } finally { setBusy(false); }
  };
  if (!state) return <p>{t("taskforce.loading")}</p>;
  const actions = snapshot.actionEntries.flatMap((entry) => (entry.actions ?? []).map((action) => ({ action, commodoreId: entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined })));
  return <div className="taskforce-details">
    {tab === "overview" ? <section className="objectives-commodore-section objectives-commodore-panel-section"><div className="objectives-commodore-panel-head"><h3 className="objectives-commodore-panel-title">{t("taskforce.topic")}</h3></div>{editingTopic ? <><textarea autoFocus className="objectives-commodore-input is-tall" aria-label={t("taskforce.topic")} maxLength={MAX_TASKFORCE_TOPIC} value={topic} readOnly={busy} onChange={(event) => setTopic(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing && !busy) { event.preventDefault(); event.stopPropagation(); setTopic(state.topic); closeTopic(); setFailed(false); } }} /><div className="objectives-commodore-description-actions"><button type="button" className="objectives-btn" disabled={busy} onClick={() => { setTopic(state.topic); closeTopic(); setFailed(false); }}>{t("taskforce.cancel")}</button><button type="button" className="objectives-btn" disabled={busy || !topic.trim() || topic === state.topic} onClick={() => void run("update", { topic: topic.trim() })}>{t("taskforce.save")}</button></div></> : <button ref={topicPreview} type="button" className={state.topic ? "objectives-commodore-description-preview" : "commodore-theaters-add"} title={state.topic ? t("taskforce.editTopic") : undefined} onClick={() => { setTopic(state.topic); setFailed(false); setEditingTopic(true); }}>{state.topic || <><span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span><span>{t("taskforce.addTopic")}</span></>}</button>}</section> : null}
    {tab === "members" ? <>{state.members.map((member) => <div className="taskforce-member" key={member}><button type="button" className="taskforce-member-open" onClick={() => { if (!openCommodoreConversation(member)) return; if (mobileId) { mobileId = null; emit(); } }}><CommodoreAvatar commodoreId={member} state={judging.includes(member) ? "running" : "idle"} size={28} label="" decorative /><strong>{memberName(member, language)}</strong></button><button type="button" className="taskforce-text-button taskforce-member-remove" disabled={busy} onClick={() => setRemoving(member)}>{t("taskforce.remove")}</button></div>)}<button ref={addRef} type="button" className="commodore-theaters-add" disabled={busy || state.members.length >= MAX_TASKFORCE_MEMBERS} aria-expanded={adding} onClick={() => setAdding(!adding)}><span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span><span>{t("taskforce.add")}</span></button>{adding ? <MemberPicker anchor={addRef.current} candidates={commodores.filter((row) => !state.members.includes(row.commodoreId)).map((row) => ({ id: row.commodoreId, name: memberName(row.commodoreId, language) }))} searchPlaceholder={t("taskforce.searchCommodores")} emptyText={t("taskforce.noMatchingCommodores")} listLabel={t("taskforce.members")} onPick={(id) => { if (busy || state.members.length >= MAX_TASKFORCE_MEMBERS) return; void run("addMembers", { commodoreIds: [id] }).finally(() => { window.requestAnimationFrame(() => { if (addRef.current?.isConnected) addRef.current.focus({ preventScroll: true }); }); }); }} onClose={() => setAdding(false)} /> : null}</> : null}
    {tab === "actions" ? <>{snapshot.actionsLoading ? <p className="taskforce-muted" role="status">{t("taskforce.loading")}</p> : null}{snapshot.actionsError ? <p className="taskforce-error" role="alert">{t("taskforce.failed")} <button type="button" className="taskforce-link" onClick={() => void loadTaskforceActions(id)}>{t("taskforce.retry")}</button></p> : null}{actions.map(({ action, commodoreId }, index) => <TaskforceActions key={index} actions={[action]} {...(commodoreId ? { commodoreId } : {})} language={language} />)}{snapshot.actionsLoaded && !actions.length ? <p className="taskforce-muted">{t("taskforce.noActions")}</p> : null}</> : null}
    {tab !== "actions" && snapshot.hasMore ? <button type="button" className="taskforce-link" disabled={busy} onClick={() => { setBusy(true); void loadTaskforce(id, true).finally(() => setBusy(false)); }}>{t("taskforce.older")}</button> : null}
    {failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}
    {removing ? <Dialog title={t("taskforce.members")} onClose={() => { if (!busy) setRemoving(null); }}><div className="taskforce-dialog-body"><p>{t("taskforce.removeConfirm", { name: memberName(removing, language) })}</p>{failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}</div><footer><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => setRemoving(null)}>{t("taskforce.cancel")}</button><button type="button" className="fc-btn fc-btn--primary" disabled={busy} onClick={() => void run("removeMembers", { commodoreId: removing })}>{t("taskforce.remove")}</button></footer></Dialog> : null}
  </div>;
}

function CurrentStack() { const surface = useConversationSurface(); const id = typeof surface?.params.taskforceId === "string" ? surface.params.taskforceId : ""; const snapshot = useTaskforce(id); return <TaskforceStack members={snapshot.state?.members ?? []} judging={snapshot.judging} />; }
const idOf = (params: Readonly<Record<string, unknown>>) => typeof params.taskforceId === "string" ? params.taskforceId : "";
export const taskforceConversationSurface: ConversationSurfaceDescriptor = {
  id: SURFACE,
  title: (ctx) => readTaskforce(idOf(ctx.params)).state?.name ?? readTaskforces().find((row) => row.id === idOf(ctx.params))?.name ?? taskforceT(ctx.language)("taskforce.title"),
  subtitle: (ctx) => readTaskforce(idOf(ctx.params)).state?.topic ?? null,
  mark: () => <CurrentStack />,
  subscribe: (listener) => { const off = subscribeTaskforces(listener); const offList = subscribeCommodoreList(listener); return () => { off(); offList(); }; },
  rename: (ctx) => (name) => { void mutateTaskforce("update", { taskforceId: idOf(ctx.params), name: name.slice(0, MAX_TASKFORCE_NAME) }).catch(() => {}); },
  // 실험이 꺼져 있으면 대화 본문을 세우지 않는다 — 열려 있던 대화는 TaskforceHost가 닫는다.
  render: (ctx) => { const experiment = readTaskforceExperiment(); if (experiment.known && !experiment.enabled) return null; return <TaskforceBody key={idOf(ctx.params)} id={idOf(ctx.params)} language={ctx.language} />; },
  opensWithoutTheater: true,
  // 플릿 브라우저의 주석·스크린샷은 이 TF의 공용 입력창에 붙는다 — 사령관 대화와 같은 수신함 길이다.
  sessionBrowser: (ctx) => {
    const taskforceId = idOf(ctx.params);
    if (!taskforceId) return null;
    return { scopeId: `taskforce:${taskforceId}`, attach: (files: readonly File[]) => attachToCommodoreComposer(taskforceId, files) };
  },
  tabs: (["overview", "members", "actions"] as const).map((tab) => ({ id: `taskforce-${tab}`, title: (language: "ko" | "en") => taskforceT(language)(`taskforce.${tab}`), defaultWidth: 310, render: (ctx) => <TaskforceDetails key={idOf(ctx.params)} id={idOf(ctx.params)} tab={tab} language={ctx.language} /> })),
  defaultTab: "taskforce-overview",
  railContinuityGroup: "commodore-taskforce",
};
