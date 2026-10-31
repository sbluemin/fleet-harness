import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "../../../workspace/shared/conversation-surfaces.js";
import type { ConversationParticipant, ConversationSpeaker } from "../../../execution/shared/conversation/types.js";
import type { AgentConversationEntry, AgentConversationProps } from "../../../execution/shared/chat-renderer.js";
import { MAX_TASKFORCE_MEMBERS, MAX_TASKFORCE_NAME, MAX_TASKFORCE_TEXT, MAX_TASKFORCE_TOPIC, TASKFORCE_ROUTE_NAMES, type TaskforceAction, type TaskforceLedgerEntry, type TaskforceState } from "../../shared/contracts/taskforce.js";
import { commodoreAvatarKey } from "../../../workspace/shared/avatars.js";
import { mongleBase } from "../../../workspace/shared/avatars.js";
import { useAvatarBook, resolveMongleLook, useMongleLook } from "../../../workspace/client/avatar-events.js";
import { useConversationSurface } from "../../../workspace/client/conversation/conversation-surface-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { CommodoreAvatar } from "../commodore-avatar.js";
import { actionWord } from "../commodore-chat.js";
import { getT as getCommodoreT } from "../i18n/index.js";
import { commodoreSectionLabel, readCommodoreList, subscribeCommodoreList, useCommodoreList } from "../commodore-list.js";
import { openCommodoreConversation } from "../commodore-conversation.js";
import { commodoreConversationRenderer } from "../commodore-state.js";
import { openReferencedObjective } from "../commodore-reference-input.js";
import { taskforceT } from "./i18n.js";
import { loadTaskforce, loadTaskforceActions, mutateTaskforce, readTaskforce, readTaskforces, subscribeTaskforces, useTaskforce, useTaskforces, wasTaskforceRemoved } from "./state.js";
import "./taskforce.css";

const SURFACE = "taskforce";
let conversation: ClientConversationCapability | undefined;
let createRequest: { readonly preselected?: string } | null = null;
let mobileId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function connectTaskforceConversation(port: ClientConversationCapability | undefined): () => void {
  conversation = port;
  return () => { if (conversation === port) conversation = undefined; };
}
export function requestTaskforceCreate(preselected?: string): void { createRequest = { ...(preselected ? { preselected } : {}) }; emit(); }
export function openTaskforce(id: string): void {
  if (!conversation?.open(SURFACE, { taskforceId: id })) { mobileId = id; emit(); }
  void loadTaskforce(id);
}
const memberName = (id: string, language: string) => {
  const row = readCommodoreList().find((row) => row.commodoreId === id);
  return row ? commodoreSectionLabel(row, language === "ko" ? "사령관" : "Commodore") : language === "ko" ? "사령관" : "Commodore";
};
const time = (at: number, language: string) => new Date(at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { dateStyle: "short", timeStyle: "short" });

export function TaskforceStack({ members, judging = [] }: { readonly members: readonly string[]; readonly judging?: readonly string[] }) {
  return <span className="taskforce-stack" aria-hidden="true">{members.slice(0, 3).map((id) => <CommodoreAvatar key={id} commodoreId={id} state={judging.includes(id) ? "running" : "idle"} size={22} label="" decorative />)}</span>;
}

export function TaskforceSidebarGroup() {
  const language = useConsoleLocale();
  const t = taskforceT(language);
  const rows = useTaskforces();
  const selected = useConversationSurface();
  useEffect(() => {
    for (const row of rows) {
      const snapshot = readTaskforce(row.id);
      if (!snapshot.loaded && !snapshot.error && row.preview && (!row.preview.text.trim() || row.preview.speaker.kind === "system" && row.preview.speaker.code !== "created")) void loadTaskforce(row.id);
    }
  }, [rows]);
  if (!rows.length) return null;
  return <li className="taskforce-sidebar" data-taskforce-group="">
    <div className="taskforce-sidebar-head"><span>{t("taskforce.title")}</span><button type="button" onClick={() => requestTaskforceCreate()} aria-label={t("taskforce.new")}>+</button></div>
    <ul>{rows.map((row) => <li key={row.id}><button type="button" className={`taskforce-sidebar-row${selected?.surfaceId === SURFACE && selected.params.taskforceId === row.id ? " is-selected" : ""}${row.status === "closed" ? " is-closed" : ""}`} onClick={() => openTaskforce(row.id)}>
      <TaskforceStack members={row.members} judging={row.judging} />
      <span className="taskforce-sidebar-copy"><strong>{row.name}</strong><small>{row.preview?.text || row.topic}</small></span>
      {row.judging.length ? <span className="taskforce-live-dot" aria-label={t("taskforce.memberJudging")} /> : null}
    </button></li>)}</ul>
  </li>;
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

function MemberChip({ id, selected, onClick, language }: { readonly id: string; readonly selected?: boolean; readonly onClick?: () => void; readonly language: string }) {
  const look = useMongleLook(commodoreAvatarKey(id));
  const tone = look.tone ?? mongleBase(look.base).tone;
  const content = <><CommodoreAvatar commodoreId={id} state="idle" size={22} label="" decorative /><span>{memberName(id, language)}</span></>;
  const style = { "--taskforce-member-ink": `var(--id-${tone})` } as CSSProperties;
  return onClick ? <button type="button" className="taskforce-member-chip" style={style} aria-pressed={selected} onClick={onClick}>{content}</button>
    : <span className="taskforce-mention" style={style}>{content}</span>;
}

function CreateDialog({ preselected, onClose }: { readonly preselected?: string; readonly onClose: () => void }) {
  const language = useConsoleLocale(); const t = taskforceT(language);
  const commodores = useCommodoreList();
  const [topic, setTopic] = useState(""); const [name, setName] = useState(""); const [editedName, setEditedName] = useState(false);
  const [members, setMembers] = useState<readonly string[]>(preselected ? [preselected] : []);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const currentMembers = members.filter((id) => commodores.some((row) => row.commodoreId === id));
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
      <fieldset><legend>{t("taskforce.members")}</legend><div className="taskforce-picks">{commodores.map((row) => <MemberChip key={row.commodoreId} id={row.commodoreId} language={language} selected={currentMembers.includes(row.commodoreId)} onClick={() => setMembers(currentMembers.includes(row.commodoreId) ? currentMembers.filter((id) => id !== row.commodoreId) : currentMembers.length < MAX_TASKFORCE_MEMBERS ? [...currentMembers, row.commodoreId] : currentMembers)} />)}</div>{currentMembers.length < 2 ? <small>{t("taskforce.minimum")}</small> : null}</fieldset>
      <label>{t("taskforce.name")}<input required maxLength={MAX_TASKFORCE_NAME} value={name} placeholder={t("taskforce.namePlaceholder")} onChange={(event) => { setEditedName(true); setName(event.target.value); }} /></label>
      {failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}
    </div><footer><small>{t("taskforce.judgements", { n: currentMembers.length })}</small><span><button type="button" className="fc-btn fc-btn--secondary" onClick={onClose} disabled={busy}>{t("taskforce.cancel")}</button><button type="submit" className="fc-btn fc-btn--primary" disabled={busy || !topic.trim() || !name.trim() || currentMembers.length < 2}>{t("taskforce.create")}</button></span></footer>
  </form></Dialog>;
}

export function TaskforceHost() {
  const request = useSyncExternalStore(subscribe, () => createRequest);
  const mobile = useSyncExternalStore(subscribe, () => mobileId);
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const rows = useTaskforces();
  const selection = useConversationSurface();
  useEffect(() => {
    if (selection?.surfaceId === SURFACE && wasTaskforceRemoved(idOf(selection.params))) conversation?.close(SURFACE);
    if (mobile && wasTaskforceRemoved(mobile)) { mobileId = null; emit(); }
  }, [rows, selection, mobile]);
  return <>{request ? <CreateDialog {...request} onClose={() => { createRequest = null; emit(); }} /> : null}{mobile ? <div className="taskforce-mobile-screen"><header><button type="button" className="fc-btn fc-btn--secondary" onClick={() => { mobileId = null; emit(); }}>{taskforceT(language)("taskforce.closeDialog")}</button><strong>{readTaskforce(mobile).state?.name}</strong></header><TaskforceBody key={mobile} id={mobile} language={language} /><TaskforceDetails id={mobile} tab="overview" language={language} /></div> : null}</>;
}

function TaskforceActions({ actions, commodoreId, language }: { readonly actions: readonly TaskforceAction[]; readonly commodoreId?: string; readonly language: string }) {
  return <div className="taskforce-action-list">{actions.map((action, index) => <div key={`${action.objectiveId}:${index}`} className="taskforce-action"><span className="taskforce-action-kind">{actionWord(getCommodoreT(language === "ko" ? "ko" : "en"), action.kind)}</span><button type="button" className="taskforce-link" onClick={() => { if (commodoreId) openReferencedObjective(commodoreId, action.objectiveId); }} disabled={!commodoreId}>{action.title || action.objectiveId}</button></div>)}</div>;
}

function MentionText({ entry, language }: { readonly entry: TaskforceLedgerEntry; readonly language: string }) {
  const remaining = [...entry.mentions];
  const pattern = remaining.map((id) => ({ id, token: `@${memberName(id, language)}` })).sort((a, b) => b.token.length - a.token.length);
  const parts: ReactNode[] = [];
  let text = entry.text;
  while (text) {
    let match: { id: string; token: string; at: number } | undefined;
    for (const member of pattern) { const at = text.indexOf(member.token); if (at >= 0 && (!match || at < match.at)) match = { ...member, at }; }
    if (!match) { parts.push(text); break; }
    parts.push(text.slice(0, match.at), <MemberChip key={parts.length} id={match.id} language={language} />);
    const index = remaining.indexOf(match.id); if (index >= 0) remaining.splice(index, 1);
    text = text.slice(match.at + match.token.length);
  }
  return <span className="taskforce-message-text">{remaining.map((id) => <MemberChip key={id} id={id} language={language} />)}{parts}</span>;
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
  const run = async (route: "continue" | "close" | "reopen") => { if (busy) return; setBusy(true); setFailure(false); try { await mutateTaskforce(route, { taskforceId: id }); } catch { setFailure(true); } finally { setBusy(false); } };
  const Conversation = commodoreConversationRenderer();
  const messageContent: AgentConversationProps["messageContent"] = (message) => {
    const entry = bySeq.get(Number(message.id)); if (!entry) return;
    const actions = [...(entry.actions ?? []), ...(actionsByReply.get(entry.seq) ?? [])];
    const owner = entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined;
    return { ...(entry.mentions.length ? { body: <MentionText entry={entry} language={language} /> } : {}), ...(actions.length ? { footer: <TaskforceActions actions={actions} {...(owner ? { commodoreId: owner } : {})} language={language} /> } : {}) };
  };
  const cards = <>{state?.status === "open" && judging.length ? <div className="taskforce-judging" role="status"><span className="taskforce-judging-avatars">{judging.map((id) => <CommodoreAvatar key={id} commodoreId={id} state="running" size={22} label="" decorative />)}</span><span>{t("taskforce.judging", { names: judging.map((id) => memberName(id, language)).join("·") })}</span><span className="taskforce-typing" aria-hidden="true">•••</span></div> : null}
    {state?.status === "open" && state.chain.paused ? <div className="taskforce-paused"><span aria-hidden="true">Ⅱ</span><div><strong>{t("taskforce.paused", { n: state.chain.count })}</strong><small>{t("taskforce.pausedHint")}</small></div><span><button type="button" className="fc-btn fc-btn--primary" disabled={busy} onClick={() => void run("continue")}>{t("taskforce.continue")}</button><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => void run("close")}>{t("taskforce.close")}</button></span></div> : null}</>;
  const composer = <div className="taskforce-foot">{failure || snapshot.error ? <p className="taskforce-error" role="alert">{t("taskforce.failed")} {snapshot.error ? <button type="button" className="taskforce-link" onClick={() => void loadTaskforce(id)}>{t("taskforce.retry")}</button> : null}</p> : null}
    {state?.status === "closed" ? <div className="taskforce-closed"><span>{t("taskforce.closedNote")}</span><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => void run("reopen")}>{t("taskforce.reopen")}</button></div> : state ? <TaskforceComposer key={id} state={state} language={language} /> : null}</div>;
  return <div className="taskforce-conversation">{Conversation ? <Conversation entries={items} participants={participants} working={[]} language={language} accessibleNames={{ log: t("taskforce.aria.log"), composer: t("taskforce.aria.composer") }} loading={!snapshot.loaded && !snapshot.error} empty={snapshot.error ? t("taskforce.failed") : t("taskforce.empty")} messageContent={messageContent} openBoardAction={{ label: t("taskforce.openNotice"), open: (entry) => { if (entry.speaker.commodoreId) openReferencedObjective(entry.speaker.commodoreId, entry.objectiveId); } }} older={snapshot.hasMore ? { label: t("taskforce.older"), loading: older, load: () => { setOlder(true); void loadTaskforce(id, true).finally(() => setOlder(false)); } } : null} cards={cards} composer={composer} /> : <>{t("taskforce.loading")}{composer}</>}</div>;
}

function TaskforceComposer({ state, language }: { readonly state: TaskforceState; readonly language: string }) {
  const t = taskforceT(language);
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const [picking, setPicking] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if (busy || !text.trim()) return;
    const sent = text; setBusy(true); setFailed(false);
    const mentions = state.members.filter((id) => sent.includes(`@${memberName(id, language)}`));
    try { await mutateTaskforce("post", { taskforceId: state.id, text: sent.trim(), mentions }); setText((current) => current === sent ? "" : current); }
    catch { setFailed(true); } finally { setBusy(false); input.current?.focus(); }
  };
  return <><div className="taskforce-composer-wrap">{picking ? <div className="taskforce-mention-picker">{state.members.map((id) => <MemberChip key={id} id={id} language={language} onClick={() => { setText((text) => `${text}${text && !/\s$/.test(text) ? " " : ""}@${memberName(id, language)} `); setPicking(false); input.current?.focus(); }} />)}</div> : null}<form className="taskforce-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <button type="button" className="taskforce-mention-button" aria-label={t("taskforce.mention")} aria-expanded={picking} onClick={() => setPicking(!picking)}>@</button><textarea ref={input} rows={1} maxLength={MAX_TASKFORCE_TEXT} value={text} placeholder={t("taskforce.placeholder")} aria-label={t("taskforce.aria.composer")} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } if (event.key === "Escape") setPicking(false); }} /><button type="submit" className="taskforce-send" aria-label={t("taskforce.send")} disabled={busy || !text.trim()}>↑</button>
  </form></div><p className="taskforce-hint">{t("taskforce.judgements", { n: state.members.length })}</p>{failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}</>;
}

type Tab = "overview" | "members" | "actions";
function TaskforceDetails({ id, tab, language }: { readonly id: string; readonly tab: Tab; readonly language: "ko" | "en" }) {
  const t = taskforceT(language); const snapshot = useTaskforce(id); const { state, judging, outcomes } = snapshot;
  const commodores = useCommodoreList(); const [topic, setTopic] = useState(""); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const [deleting, setDeleting] = useState(false); const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => { void loadTaskforce(id); }, [id]);
  useEffect(() => setTopic(state?.topic ?? ""), [state?.topic]);
  useEffect(() => { if (tab === "actions") void loadTaskforceActions(id); }, [id, tab]);
  const run = async (route: "update" | "close" | "reopen" | "delete" | "addMembers" | "removeMembers", body: object = {}) => {
    if (busy) return; setBusy(true); setFailed(false);
    try { await mutateTaskforce(route, { taskforceId: id, ...body }); if (route === "delete") { conversation?.close(SURFACE); if (mobileId === id) { mobileId = null; emit(); } } setDeleting(false); setRemoving(null); }
    catch { setFailed(true); } finally { setBusy(false); }
  };
  if (!state) return <p>{t("taskforce.loading")}</p>;
  const actions = snapshot.actionEntries.flatMap((entry) => (entry.actions ?? []).map((action) => ({ action, commodoreId: entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined })));
  return <div className="taskforce-details">
    {tab === "overview" ? <><label className="taskforce-field">{t("taskforce.topic")}<textarea rows={4} maxLength={MAX_TASKFORCE_TOPIC} value={topic} onChange={(event) => setTopic(event.target.value)} /></label>{topic !== state.topic ? <button type="button" className="fc-btn fc-btn--secondary" disabled={busy || !topic.trim()} onClick={() => void run("update", { topic: topic.trim() })}>{t("taskforce.save")}</button> : null}<dl><dt>{t("taskforce.status")}</dt><dd>{t(state.status === "open" ? "taskforce.open" : "taskforce.closed")}</dd><dt>{t("taskforce.createdAt")}</dt><dd>{time(state.createdAt, language)}</dd><dt>{t("taskforce.utterances")}</dt><dd>{t("taskforce.utteranceCounts", { n: state.counts.person + state.counts.commodore, person: state.counts.person, commodore: state.counts.commodore })}</dd><dt>{t("taskforce.chain")}</dt><dd>{state.chain.count}/{state.chain.limit}</dd><dt>{t("taskforce.retention")}</dt><dd>{t("taskforce.keepAll")}</dd></dl><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => void run(state.status === "open" ? "close" : "reopen")}>{t(state.status === "open" ? "taskforce.close" : "taskforce.reopen")}</button><button type="button" className="taskforce-danger" onClick={() => setDeleting(true)}>{t("taskforce.delete")}</button></> : null}
    {tab === "members" ? <>{state.members.map((member) => { const last = outcomes[member]; return <div className="taskforce-member" key={member}><CommodoreAvatar commodoreId={member} state={judging.includes(member) ? "running" : "idle"} size={28} label="" decorative /><div><strong>{memberName(member, language)}</strong><small>{judging.includes(member) ? t("taskforce.memberJudging") : last ? t(last.outcome === "spoke" ? "taskforce.lastSpoke" : last.outcome === "silent" ? "taskforce.lastSilent" : "taskforce.lastFailed", { time: new Date(last.at).toLocaleTimeString(language === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) }) : t("taskforce.idle")}</small><button type="button" className="taskforce-link" onClick={() => { if (!openCommodoreConversation(member)) return; if (mobileId) { mobileId = null; emit(); } }}>{t("taskforce.oneToOne")}</button></div><button type="button" className="taskforce-text-button" disabled={busy} onClick={() => setRemoving(member)}>{t("taskforce.remove")}</button></div>; })}<h4>{t("taskforce.add")}</h4><div className="taskforce-picks">{commodores.filter((row) => !state.members.includes(row.commodoreId)).map((row) => <MemberChip key={row.commodoreId} id={row.commodoreId} language={language} onClick={busy || state.members.length >= MAX_TASKFORCE_MEMBERS ? undefined : () => void run("addMembers", { commodoreIds: [row.commodoreId] })} />)}</div></> : null}
    {tab === "actions" ? <>{snapshot.actionsLoading ? <p className="taskforce-muted" role="status">{t("taskforce.loading")}</p> : null}{snapshot.actionsError ? <p className="taskforce-error" role="alert">{t("taskforce.failed")} <button type="button" className="taskforce-link" onClick={() => void loadTaskforceActions(id)}>{t("taskforce.retry")}</button></p> : null}{actions.map(({ action, commodoreId }, index) => <TaskforceActions key={index} actions={[action]} {...(commodoreId ? { commodoreId } : {})} language={language} />)}{snapshot.actionsLoaded && !actions.length ? <p className="taskforce-muted">{t("taskforce.noActions")}</p> : null}</> : null}
    {tab !== "actions" && snapshot.hasMore ? <button type="button" className="taskforce-link" disabled={busy} onClick={() => { setBusy(true); void loadTaskforce(id, true).finally(() => setBusy(false)); }}>{t("taskforce.older")}</button> : null}
    {failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}
    {deleting ? <Dialog title={t("taskforce.deleteTitle")} onClose={() => { if (!busy) setDeleting(false); }}><div className="taskforce-dialog-body"><p>{t("taskforce.deleteWarning", { name: state.name })}</p>{failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}</div><footer><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => setDeleting(false)}>{t("taskforce.cancel")}</button><button type="button" className="fc-btn taskforce-danger" disabled={busy} onClick={() => void run("delete")}>{t("taskforce.deleteConfirm")}</button></footer></Dialog> : null}
    {removing ? <Dialog title={t("taskforce.members")} onClose={() => { if (!busy) setRemoving(null); }}><div className="taskforce-dialog-body"><p>{t("taskforce.removeConfirm", { name: memberName(removing, language) })}</p>{failed ? <p className="taskforce-error" role="alert">{t("taskforce.failed")}</p> : null}</div><footer><button type="button" className="fc-btn fc-btn--secondary" disabled={busy} onClick={() => setRemoving(null)}>{t("taskforce.cancel")}</button><button type="button" className="fc-btn fc-btn--primary" disabled={busy} onClick={() => void run("removeMembers", { commodoreId: removing })}>{t("taskforce.remove")}</button></footer></Dialog> : null}
  </div>;
}

export function TaskforceNotice({ commodoreId, language }: { readonly commodoreId: string; readonly language: string }) {
  const taskforces = useTaskforces().filter((row) => row.members.includes(commodoreId)); const t = taskforceT(language);
  if (!taskforces.length) return null;
  return <div className="taskforce-notices">{taskforces.map((row) => <div className="taskforce-notice" key={row.id}><span>{t("taskforce.notice", { name: row.name })}</span><span aria-hidden="true">·</span><button type="button" className="taskforce-link" onClick={() => openTaskforce(row.id)}>{t("taskforce.openNotice")}</button></div>)}</div>;
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
  render: (ctx) => <TaskforceBody key={idOf(ctx.params)} id={idOf(ctx.params)} language={ctx.language} />,
  opensWithoutTheater: true,
  tabs: (["overview", "members", "actions"] as const).map((tab) => ({ id: `taskforce-${tab}`, title: (language: "ko" | "en") => taskforceT(language)(`taskforce.${tab}`), defaultWidth: 310, render: (ctx) => <TaskforceDetails key={idOf(ctx.params)} id={idOf(ctx.params)} tab={tab} language={ctx.language} /> })),
  defaultTab: "taskforce-overview",
};
