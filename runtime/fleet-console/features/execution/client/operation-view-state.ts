import { composeQuotedPrompt, composerQuoteValues, createComposerAttachments, createComposerQuotes, type ComposerAttachmentNotice, type ComposerAttachmentRecord, type ComposerAttachments, type ComposerQuote, type ComposerQuoteAttachResult, type ComposerQuoteItem } from "@fleet-console/sdk/composer";
import type { ClientConsoleStateCapability } from "@fleet-console/sdk/plugin";

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
  /** 답 단추가 초안을 채운 횟수 — 입력창이 이 값이 오를 때 커서를 데려온다(폰은 화면 키보드를 올리지 않는다). */
  readonly filled: number;
  /** 쓰던 말이 있어 답 단추가 초안을 덮지 않은 횟수 — 입력창이 이 값이 오를 때 안내 줄을 세운다. */
  readonly occupied: number;
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
let liveOperationIds: ReadonlySet<string> | null = null;

function createComposerDraft(operationId: string) {
  const attachments: ComposerAttachments = createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  });
  const quotes = createComposerQuotes();
  let current: Omit<ComposerDraft, "attachments" | "attachmentNotice" | "quotes"> = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false, filled: 0, occupied: 0 };
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
    /**
     * 답 단추(OpenUI)가 고른 문장을 빈 초안에 넣는다. 보내지 않는다 — 발사는 사람의 Enter 다. 쓰던 말이 있으면 덮지 않고 알린다.
     */
    fill: (text: string): boolean => {
      if (current.text.trim().length > 0) { update({ occupied: current.occupied + 1 }); return false; }
      update({ text, revision: current.revision + 1, failed: false, filled: current.filled + 1 });
      return true;
    },
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
        await messageAgentSession(operationId, composeQuotedPrompt(text, composerQuoteValues(sentQuotes)), ids.length > 0 ? ids : undefined);
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
      current = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false, filled: 0, occupied: 0 };
      view = { ...current, attachments: [], attachmentNotice: null, quotes: [] };
      listeners.clear();
    },
  };
}

export function getComposerDraft(operationId: string): ReturnType<typeof createComposerDraft> {
  let draft = drafts.get(operationId);
  if (!draft) { draft = createComposerDraft(operationId); drafts.set(operationId, draft); }
  return draft;
}

/**
 * 다른 표면이 고른 문장을 이 Operation 입력창의 초안에 인용 칩으로 붙인다. 입력창이 화면에 없어도 초안에 남고(이미지 수신함과 달리
 * 꺼낼 사람이 필요 없다), 채팅 원장과 대화 중심 화면의 그룹 입력창이 같은 묶음을 읽는다. 보내지는 않는다.
 */
export function attachComposerQuote(operationId: string, quote: ComposerQuote): ComposerQuoteAttachResult {
  if (liveOperationIds !== null && !liveOperationIds.has(operationId)) return "unavailable";
  return getComposerDraft(operationId).quotes.add(quote);
}

export function readTerminalViewPosition(operationId: string): TerminalViewPosition | undefined {
  return terminalPositions.get(operationId);
}

export function saveTerminalViewPosition(operationId: string, position: TerminalViewPosition): void {
  // 삭제 알림이 React cleanup보다 먼저 온 경우에도 늦은 본문 정리가 항목을 되살리지 않는다.
  if (liveOperationIds !== null && !liveOperationIds.has(operationId)) return;
  terminalPositions.set(operationId, position);
}

export function disposeOperationViewState(operationId: string): void {
  drafts.get(operationId)?.dispose();
  drafts.delete(operationId);
  terminalPositions.delete(operationId);
}

export function installOperationViewState(consoleState: ClientConsoleStateCapability): () => void {
  const prune = () => {
    const ids = new Set(consoleState.getOperations({ nested: true }).map((operation) => operation.id));
    liveOperationIds = ids;
    for (const id of new Set([...drafts.keys(), ...terminalPositions.keys()])) {
      if (!ids.has(id)) disposeOperationViewState(id);
    }
  };
  const unsubscribe = consoleState.subscribe(prune);
  prune();
  return () => {
    unsubscribe();
    liveOperationIds = new Set();
    for (const id of new Set([...drafts.keys(), ...terminalPositions.keys()])) disposeOperationViewState(id);
  };
}
