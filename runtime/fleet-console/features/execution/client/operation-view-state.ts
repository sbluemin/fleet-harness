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
  readonly attachments: readonly ComposerDraftAttachment[];
  readonly sending: boolean;
  readonly sentEpoch: number;
  readonly failed: boolean;
  readonly uploadFailed: boolean;
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

function releaseAttachment(attachment: ComposerDraftAttachment, discard: boolean): void {
  URL.revokeObjectURL(attachment.previewUrl);
  if (discard && attachment.id !== null) void discardLaunchAttachment(attachment.id).catch(() => {});
}

function createComposerDraft(operationId: string) {
  let current: ComposerDraft = { text: "", revision: 0, attachments: [], sending: false, sentEpoch: 0, failed: false, uploadFailed: false, ultracodeIgnored: false };
  let disposed = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ComposerDraft>): void => {
    if (disposed) return;
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    read: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText: (text: string) => update({ text, revision: current.revision + 1, failed: false }),
    setUltracodeIgnored: (ultracodeIgnored: boolean) => update({ ultracodeIgnored }),
    clearUploadFailure: () => update({ uploadFailed: false }),
    addFile: (file: File) => {
      if (disposed) return;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      const attachment = { key, id: null, name: file.name || "pasted image", previewUrl, uploading: true };
      update({ attachments: [...current.attachments, attachment], uploadFailed: false });
      void uploadLaunchAttachment(file).then(({ id }) => {
        if (disposed || !current.attachments.some((entry) => entry.key === key)) {
          void discardLaunchAttachment(id).catch(() => {});
          return;
        }
        update({ attachments: current.attachments.map((entry) => entry.key === key ? { ...entry, id, uploading: false } : entry) });
      }).catch(() => {
        if (disposed || !current.attachments.some((entry) => entry.key === key)) return;
        releaseAttachment(attachment, false);
        update({ attachments: current.attachments.filter((entry) => entry.key !== key), uploadFailed: true });
      });
    },
    removeAttachment: (key: string) => {
      const attachment = current.attachments.find((entry) => entry.key === key);
      if (!attachment) return;
      releaseAttachment(attachment, true);
      update({ attachments: current.attachments.filter((entry) => entry.key !== key), uploadFailed: false });
    },
    send: async (text: string): Promise<boolean> => {
      if (disposed || current.sending || current.attachments.some((entry) => entry.uploading)) return false;
      const revision = current.revision;
      const sentAttachments = current.attachments;
      const ids = sentAttachments.flatMap((entry) => entry.id === null ? [] : [entry.id]);
      update({ sending: true, failed: false });
      try {
        await messageAgentSession(operationId, text, ids.length > 0 ? ids : undefined);
        if (disposed) return true;
        for (const attachment of sentAttachments) releaseAttachment(attachment, false);
        update({
          ...(current.revision === revision ? { text: "", revision: revision + 1, ultracodeIgnored: false } : {}),
          attachments: current.attachments.filter((entry) => !sentAttachments.includes(entry)),
          sentEpoch: current.sentEpoch + 1,
        });
        return true;
      } catch {
        update({ failed: true });
        return false;
      } finally {
        update({ sending: false });
      }
    },
    dispose: () => {
      disposed = true;
      for (const attachment of current.attachments) releaseAttachment(attachment, true);
      current = { text: "", revision: 0, attachments: [], sending: false, sentEpoch: 0, failed: false, uploadFailed: false, ultracodeIgnored: false };
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
