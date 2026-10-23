import { composeQuotedPrompt, composerQuoteValues, createComposerQuotes, type ComposerQuote, type ComposerQuoteAttachResult, type ComposerQuoteItem } from "./composer-primitives/quotes.js";
import { createComposerAttachments, type ComposerAttachmentNotice, type ComposerAttachmentRecord, type ComposerAttachments } from "./composer-primitives/attachment-store.js";
import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";

import { discardLaunchAttachment, messageAgentSession, uploadLaunchAttachment } from "./agent/api.js";

export interface ComposerDraftAttachment {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
}

interface ComposerDraft {
  readonly text: string;
  readonly revision: number;
  readonly attachments: readonly ComposerAttachmentRecord[];
  readonly attachmentNotice: ComposerAttachmentNotice | null;
  /** 다른 표면(Codex 문서 등)이 붙인 인용 칩. 보낼 때 프롬프트 끝에 합성된다. */
  readonly quotes: readonly ComposerQuoteItem[];
  readonly sending: boolean;
  readonly sentEpoch: number;
  readonly failed: boolean;
  readonly ultracodeIgnored: boolean;
}

export interface TerminalViewPosition {
  readonly generation?: number;
  readonly following: boolean;
  readonly bottomDistance: number;
}

// 본문은 레이아웃 경계에서 내려간다. 사용자 입력과 읽던 좌표만 페이지 메모리에 남기며,
// DOM·React 콜백·소켓·xterm은 담지 않는다. 전송과 업로드의 결말도 이 상태가 소유한다.
const drafts = new Map<string, ReturnType<typeof createComposerDraft>>();
const terminalPositions = new Map<string, TerminalViewPosition>();
let liveObjectiveIds: ReadonlySet<string> | null = null;

function createComposerDraft(objectiveId: string) {
  const attachments: ComposerAttachments = createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  });
  const quotes = createComposerQuotes();
  let current: Omit<ComposerDraft, "attachments" | "attachmentNotice" | "quotes"> = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false };
  let disposed = false;
  const listeners = new Set<() => void>();
  // useSyncExternalStore는 스냅샷 참조가 같으면 멈춘다. 매 읽기마다 새 객체를 만들면 렌더가 끝나지 않는다.
  let view: ComposerDraft = { ...current, attachments: [], attachmentNotice: null, quotes: [] };
  const publish = (): void => {
    if (disposed) return;
    const snap = attachments.read();
    view = { ...current, attachments: snap.items, attachmentNotice: snap.notice, quotes: quotes.read() };
    for (const listener of listeners) listener();
  };
  const update = (patch: Partial<typeof current>): void => {
    if (disposed) return;
    current = { ...current, ...patch };
    publish();
  };
  attachments.subscribe(publish);
  quotes.subscribe(publish);
  const read = (): ComposerDraft => view;
  return {
    attachments,
    quotes,
    read,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText: (text: string) => update({ text, revision: current.revision + 1, failed: false }),
    setUltracodeIgnored: (ultracodeIgnored: boolean) => update({ ultracodeIgnored }),
    addFile: (file: File) => { attachments.add([file]); },
    removeAttachment: (key: string) => { attachments.remove(key); },
    send: async (text: string): Promise<boolean> => {
      if (disposed || current.sending || attachments.read().uploading) return false;
      const revision = current.revision;
      const sent = attachments.read().items;
      const sentKeys = sent.map((entry) => entry.key);
      const ids = attachments.ids();
      const sentQuotes = quotes.read();
      update({ sending: true, failed: false });
      try {
        // 인용은 문면 끝 줄로 합성된다 — 서버가 말풍선 문면에서 그 줄을 떼어 칩으로 기록한다(`splitQuotedPrompt`).
        await messageAgentSession(objectiveId, composeQuotedPrompt(text, composerQuoteValues(sentQuotes)), ids.length > 0 ? ids : undefined);
        if (disposed) return true;
        attachments.releaseSent(sentKeys);
        quotes.releaseSent(sentQuotes.map((quote) => quote.key));
        update({
          ...(current.revision === revision ? { text: "", revision: revision + 1, ultracodeIgnored: false } : {}),
          sentEpoch: current.sentEpoch + 1,
        });
        return true;
      } catch (error) {
        if (attachments.noteSendFailure(error, ids) !== "expired") update({ failed: true });
        return false;
      } finally {
        update({ sending: false });
      }
    },
    dispose: () => {
      disposed = true;
      attachments.dispose();
      quotes.clear();
      current = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false };
      view = { ...current, attachments: [], attachmentNotice: null, quotes: [] };
      listeners.clear();
    },
  };
}

export function getComposerDraft(objectiveId: string): ReturnType<typeof createComposerDraft> {
  let draft = drafts.get(objectiveId);
  if (!draft) { draft = createComposerDraft(objectiveId); drafts.set(objectiveId, draft); }
  return draft;
}

/**
 * 다른 표면이 고른 문장을 이 Objective 입력창의 초안에 인용 칩으로 붙인다. 입력창이 화면에 없어도 초안에 남고(이미지 수신함과 달리
 * 꺼낼 사람이 필요 없다), 채팅 원장과 대화 중심 화면의 그룹 입력창이 같은 묶음을 읽는다. 보내지는 않는다.
 */
export function attachComposerQuote(objectiveId: string, quote: ComposerQuote): ComposerQuoteAttachResult {
  if (liveObjectiveIds !== null && !liveObjectiveIds.has(objectiveId)) return "unavailable";
  return getComposerDraft(objectiveId).quotes.add(quote);
}

export function readTerminalViewPosition(objectiveId: string): TerminalViewPosition | undefined {
  return terminalPositions.get(objectiveId);
}

export function saveTerminalViewPosition(objectiveId: string, position: TerminalViewPosition): void {
  // 삭제 알림이 React cleanup보다 먼저 온 경우에도 늦은 본문 정리가 항목을 되살리지 않는다.
  if (liveObjectiveIds !== null && !liveObjectiveIds.has(objectiveId)) return;
  terminalPositions.set(objectiveId, position);
}

export function disposeObjectiveViewState(objectiveId: string): void {
  drafts.get(objectiveId)?.dispose();
  drafts.delete(objectiveId);
  terminalPositions.delete(objectiveId);
}

export function installObjectiveViewState(consoleState: ClientConsoleStateCapability): () => void {
  const prune = () => {
    const ids = new Set(consoleState.getObjectiveRecords({ nested: true }).map((objectiveRecord) => objectiveRecord.id));
    liveObjectiveIds = ids;
    for (const id of new Set([...drafts.keys(), ...terminalPositions.keys()])) {
      if (!ids.has(id)) disposeObjectiveViewState(id);
    }
  };
  const unsubscribe = consoleState.subscribe(prune);
  prune();
  return () => {
    unsubscribe();
    liveObjectiveIds = new Set();
    for (const id of new Set([...drafts.keys(), ...terminalPositions.keys()])) disposeObjectiveViewState(id);
  };
}
