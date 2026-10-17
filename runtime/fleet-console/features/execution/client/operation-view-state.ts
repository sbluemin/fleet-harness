import { createComposerAttachments, type ComposerAttachmentNotice, type ComposerAttachmentRecord, type ComposerAttachments } from "@fleet-console/sdk/composer";
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
let liveOperationIds: ReadonlySet<string> | null = null;

function createComposerDraft(operationId: string) {
  const attachments: ComposerAttachments = createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  });
  let current: Omit<ComposerDraft, "attachments" | "attachmentNotice"> = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false };
  let disposed = false;
  const listeners = new Set<() => void>();
  // useSyncExternalStore는 스냅샷 참조가 같으면 멈춘다. 매 읽기마다 새 객체를 만들면 렌더가 끝나지 않는다.
  let view: ComposerDraft = { ...current, attachments: [], attachmentNotice: null };
  const publish = (): void => {
    if (disposed) return;
    const snap = attachments.read();
    view = { ...current, attachments: snap.items, attachmentNotice: snap.notice };
    for (const listener of listeners) listener();
  };
  const update = (patch: Partial<typeof current>): void => {
    if (disposed) return;
    current = { ...current, ...patch };
    publish();
  };
  attachments.subscribe(publish);
  const read = (): ComposerDraft => view;
  return {
    attachments,
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
      update({ sending: true, failed: false });
      try {
        await messageAgentSession(operationId, text, ids.length > 0 ? ids : undefined);
        if (disposed) return true;
        attachments.releaseSent(sentKeys);
        update({
          ...(current.revision === revision ? { text: "", revision: revision + 1, ultracodeIgnored: false } : {}),
          sentEpoch: current.sentEpoch + 1,
        });
        return true;
      } catch (error) {
        if (attachments.noteSendFailure(error) !== "expired") update({ failed: true });
        return false;
      } finally {
        update({ sending: false });
      }
    },
    dispose: () => {
      disposed = true;
      attachments.dispose();
      current = { text: "", revision: 0, sending: false, sentEpoch: 0, failed: false, ultracodeIgnored: false };
      view = { ...current, attachments: [], attachmentNotice: null };
      listeners.clear();
    },
  };
}

export function getComposerDraft(operationId: string): ReturnType<typeof createComposerDraft> {
  let draft = drafts.get(operationId);
  if (!draft) { draft = createComposerDraft(operationId); drafts.set(operationId, draft); }
  return draft;
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
