import { COMPOSER_ATTACHMENT_MAX_BYTES, COMPOSER_MAX_ATTACHMENTS, isComposerAttachmentCandidate } from "./attachments.js";

/**
 * 컴포저 첨부 상태 — 다섯 표면이 각자 만들되, 상태기계는 이 한 벌이다.
 *
 * 호스트와 플러그인 번들이 이 모듈을 따로 적재하므로 인스턴스는 표면이 만들고 보관한다.
 * 모듈 스코프에 초안을 두지 않는다. 업로드·삭제는 주입된 포트만 부른다.
 *
 * 보내기 전 미리보기는 object URL이다. 서버 `/preview`는 세션에 묶인 뒤에만 열린다.
 */

const ATTACHMENT_EXPIRED = "attachment_not_found";

export interface ComposerAttachmentPort {
  upload(file: Blob): Promise<{ readonly id: string }>;
  discard(id: string): Promise<void>;
}

export interface ComposerAttachmentLimits {
  readonly max: number;
  readonly bytes: number;
}

export interface ComposerAttachmentRecord {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
  /** 저장까지 끝난 편집본. 주석은 이미지에 합쳐져 있고, 보내기 전까지만 원본으로 되돌릴 수 있다. */
  readonly edited: boolean;
}

/** 동기 거절(상한·용량)과, 업로드가 끝난 뒤의 거절(실패·형식·보관 한도)과, 보낸 토큰이 만료된 경우. */
export type ComposerAttachmentNoticeKind = "limit" | "tooLarge" | "failed" | "expired" | "unsupported" | "storage";

export interface ComposerAttachmentNotice {
  readonly kind: ComposerAttachmentNoticeKind;
}

export interface ComposerAttachmentsSnapshot {
  readonly items: readonly ComposerAttachmentRecord[];
  readonly uploading: boolean;
  readonly notice: ComposerAttachmentNotice | null;
}

/** 이미 서버 id가 있는 칩. 미리보기 URL의 소유권은 넘기는 쪽이 정한다. */
export interface ComposerAttachmentDraftItem {
  readonly id: string;
  readonly name: string;
  readonly previewUrl: string;
  /** 보내기 전 되돌릴 원본 바이트. 발사 요청 객체에만 실리고 서버로는 id만 나간다. */
  readonly source?: Blob;
  readonly edited?: boolean;
}

export type ComposerAttachmentEditResult = "ok" | "tooLarge" | "failed" | "missing";

export interface ComposerAttachments {
  read(): ComposerAttachmentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** 이미지 후보만 올린다. 후보가 없으면 안내를 건드리지 않는다. 동기 거절이 있으면 그 종류를 돌려준다. */
  add(files: readonly File[], nameFor?: (file: File) => string): "limit" | "tooLarge" | null;
  remove(key: string): void;
  ids(): readonly string[];
  clearNotice(): void;
  /** 업로드가 끝난 칩. 스토어는 비우지 않는다 — 닫힘 보존이 사본만 슬롯에 남긴다. */
  uploaded(): readonly ComposerAttachmentDraftItem[];
  /**
   * 업로드가 끝난 칩을 회수 없이 뺀다. 진행 중 칩은 남겨 완료가 승급하게 한다.
   * 빼낸 미리보기의 소유권은 호출부(초안 슬롯)로 넘어간다.
   */
  detach(): readonly ComposerAttachmentDraftItem[];
  /**
   * 발사로 넘긴다. 업로드가 끝난 칩은 revoke·discard 없이 빠지고, 진행 중 칩은 완료 때 서버에서 거둔다.
   * 미리보기 소유권은 실행 의도로 넘어간다.
   */
  handoff(): readonly ComposerAttachmentDraftItem[];
  /** 슬롯의 칩을 지금 스토어에 합친다. 같은 미리보기는 한 번만 둔다. */
  restore(items: readonly ComposerAttachmentDraftItem[]): void;
  /**
   * 슬롯으로 교체한다. 슬롯에 없는 칩은 거둔다.
   * `rejection`이 `attachment_not_found`면 슬롯 칩은 되살리지 않고 미리보기만 회수한 뒤 만료 안내를 세운다.
   */
  replaceFromSlot(items: readonly ComposerAttachmentDraftItem[], rejection?: string | null): void;
  /** 지금 칩과, 슬롯에만 남아 있는 칩까지 미리보기·서버 파일을 거둔다. */
  discardAll(extra?: readonly ComposerAttachmentDraftItem[]): void;
  /** 보낸 칩의 미리보기를 회수한다. `discard`면 서버 파일도 지운다(보내지 않고 초안을 버리는 길). */
  releaseSent(keys: readonly string[], discard?: boolean): void;
  /**
   * 전송이 `attachment_not_found`로 거절되면 그 전송에 실린 칩(`submittedIds`)만 걷는다.
   * 서버가 이미 회수했으므로 discard는 부르지 않는다. 전송 중 새로 붙은 칩, 진행 중 칩, 초안 문면은 건드리지 않는다.
   */
  noteSendFailure(error: unknown, submittedIds: readonly string[]): "expired" | "other";
  /**
   * 편집본을 새로 올리고 지금 업로드에는 삭제 요청을 보낸다. 첫 저장 때 미리보기의 바이트를 원본으로 잡아 둔다.
   * 실패하면 칩은 그대로다. 업로드 도중 칩을 빼면 옛 id와 새 id를 모두 거둔다.
   */
  commitEdit(key: string, file: Blob): Promise<ComposerAttachmentEditResult>;
  /** 잡아 둔 원본을 다시 올리고 편집본 업로드에 삭제 요청을 보낸다. 원본 바이트는 보낼 때까지 남긴다. */
  revertEdit(key: string): Promise<ComposerAttachmentEditResult>;
  dispose(): void;
}

interface MutableItem {
  key: string;
  id: string | null;
  name: string;
  previewUrl: string;
  uploading: boolean;
  edited: boolean;
  source: Blob | null;
}

export function isComposerAttachmentExpired(error: unknown): boolean {
  if (typeof error === "string") return error === ATTACHMENT_EXPIRED;
  return error instanceof Error && error.message === ATTACHMENT_EXPIRED;
}

function uploadNotice(error: unknown): ComposerAttachmentNotice {
  const code = error instanceof Error ? error.message : "";
  if (code === "attachment_too_large") return { kind: "tooLarge" };
  if (code === "attachment_unsupported") return { kind: "unsupported" };
  if (code === "attachment_limit") return { kind: "limit" };
  if (code === "attachment_storage_exhausted") return { kind: "storage" };
  return { kind: "failed" };
}

function draftOf(item: MutableItem): ComposerAttachmentDraftItem | null {
  if (item.id === null) return null;
  return {
    id: item.id,
    name: item.name,
    previewUrl: item.previewUrl,
    ...(item.source ? { source: item.source } : {}),
    ...(item.edited ? { edited: true } : {}),
  };
}

function carriedSource(item: ComposerAttachmentDraftItem): Blob | null {
  return item.source instanceof Blob ? item.source : null;
}

export function createComposerAttachments(
  port: ComposerAttachmentPort,
  limits: ComposerAttachmentLimits = { max: COMPOSER_MAX_ATTACHMENTS, bytes: COMPOSER_ATTACHMENT_MAX_BYTES },
): ComposerAttachments {
  let items: MutableItem[] = [];
  let notice: ComposerAttachmentNotice | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const canceled = new Set<string>();
  let snapshot: ComposerAttachmentsSnapshot = { items: [], uploading: false, notice: null };

  const emit = (): void => {
    snapshot = {
      items: items.map((item) => ({ key: item.key, id: item.id, name: item.name, previewUrl: item.previewUrl, uploading: item.uploading, edited: item.edited })),
      uploading: items.some((item) => item.uploading),
      notice,
    };
    for (const listener of [...listeners]) listener();
  };

  const revoke = (previewUrl: string): void => {
    URL.revokeObjectURL(previewUrl);
  };

  const discard = (id: string): void => {
    void port.discard(id).catch(() => {});
  };

  const stillThere = (key: string): boolean => items.some((item) => item.key === key);

  return {
    read: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    add: (files, nameFor) => {
      if (disposed) return null;
      const images = files.filter((file) => isComposerAttachmentCandidate(file));
      if (images.length === 0) return null;
      notice = null;
      let rejection: "limit" | "tooLarge" | null = null;
      let count = items.length;
      for (const file of images) {
        if (count >= limits.max) {
          rejection = "limit";
          notice = { kind: "limit" };
          break;
        }
        if (file.size > limits.bytes) {
          rejection = "tooLarge";
          notice = { kind: "tooLarge" };
          continue;
        }
        count += 1;
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const previewUrl = URL.createObjectURL(file);
        const named = (nameFor?.(file) ?? "").trim();
        const name = named.length > 0 ? named : file.name.trim().length > 0 ? file.name : "pasted image";
        items.push({ key, id: null, name, previewUrl, uploading: true, edited: false, source: null });
        void port.upload(file).then(({ id }) => {
          if (disposed || canceled.delete(key) || !stillThere(key)) {
            revoke(previewUrl);
            discard(id);
            return;
          }
          const found = items.find((item) => item.key === key);
          if (!found) return;
          found.id = id;
          found.uploading = false;
          emit();
        }).catch((error: unknown) => {
          if (disposed || canceled.delete(key) || !stillThere(key)) return;
          revoke(previewUrl);
          items = items.filter((item) => item.key !== key);
          notice = uploadNotice(error);
          emit();
        });
      }
      emit();
      return rejection;
    },
    remove: (key) => {
      const found = items.find((item) => item.key === key);
      if (!found || disposed) return;
      // 미리보기는 바로 회수한다. 업로드가 아직이면 완료 콜백이 받은 id를 서버에서 거둔다.
      if (found.uploading) canceled.add(key);
      else if (found.id !== null) discard(found.id);
      revoke(found.previewUrl);
      items = items.filter((item) => item.key !== key);
      notice = null;
      emit();
    },
    ids: () => items.flatMap((item) => item.id === null ? [] : [item.id]),
    clearNotice: () => {
      if (notice === null) return;
      notice = null;
      emit();
    },
    uploaded: () => items.flatMap((item) => {
      const draft = draftOf(item);
      return draft === null ? [] : [draft];
    }),
    detach: () => {
      const kept = items.flatMap((item) => {
        const draft = draftOf(item);
        return draft === null ? [] : [draft];
      });
      items = items.filter((item) => item.id === null);
      emit();
      return kept;
    },
    handoff: () => {
      const kept = items.flatMap((item) => {
        const draft = draftOf(item);
        return draft === null ? [] : [draft];
      });
      for (const item of items) {
        if (item.uploading) canceled.add(item.key);
      }
      items = [];
      emit();
      return kept;
    },
    restore: (slot) => {
      if (disposed) return;
      const have = new Set(items.map((item) => item.previewUrl));
      for (const item of slot) {
        if (have.has(item.previewUrl)) continue;
        have.add(item.previewUrl);
        items.push({ key: item.id, id: item.id, name: item.name, previewUrl: item.previewUrl, uploading: false, edited: item.edited === true, source: carriedSource(item) });
      }
      emit();
    },
    replaceFromSlot: (slot, rejection) => {
      if (disposed) return;
      const expired = isComposerAttachmentExpired(rejection ?? null);
      const slotPreviews = new Set(slot.map((item) => item.previewUrl));
      for (const item of items) {
        if (!expired && slotPreviews.has(item.previewUrl)) continue;
        if (item.uploading) {
          canceled.add(item.key);
          continue;
        }
        revoke(item.previewUrl);
        if (item.id !== null) discard(item.id);
      }
      if (expired) {
        // 서버는 첫 누락에서 거절하므로 나머지 장은 아직 대기 중이다. 칩을 버리는 만큼 서버 파일도 거둔다
        // (이미 회수된 장의 discard 실패는 삼킨다) — 남기면 TTL까지 대기 상한을 잡아먹는다.
        for (const item of slot) {
          if (!slotPreviews.has(item.previewUrl)) continue;
          revoke(item.previewUrl);
          discard(item.id);
          slotPreviews.delete(item.previewUrl);
        }
        items = [];
        notice = { kind: "expired" };
      } else {
        items = slot.map((item) => ({ key: item.id, id: item.id, name: item.name, previewUrl: item.previewUrl, uploading: false, edited: item.edited === true, source: carriedSource(item) }));
        notice = null;
      }
      emit();
    },
    discardAll: (extra = []) => {
      const seen = new Set<string>();
      const drop = (previewUrl: string, id: string | null, key: string | null, uploading: boolean): void => {
        if (seen.has(previewUrl)) return;
        seen.add(previewUrl);
        if (uploading && key !== null) {
          canceled.add(key);
          return;
        }
        revoke(previewUrl);
        if (id !== null) discard(id);
      };
      for (const item of items) drop(item.previewUrl, item.id, item.key, item.uploading);
      for (const item of extra) drop(item.previewUrl, item.id, null, false);
      items = [];
      notice = null;
      emit();
    },
    releaseSent: (keys, discardIds = false) => {
      const keySet = new Set(keys);
      for (const item of items) {
        if (!keySet.has(item.key)) continue;
        if (item.uploading) canceled.add(item.key);
        else revoke(item.previewUrl);
        if (discardIds && item.id !== null) discard(item.id);
      }
      items = items.filter((item) => !keySet.has(item.key));
      emit();
    },
    commitEdit: async (key, file) => {
      const found = items.find((item) => item.key === key);
      if (!found || disposed || found.uploading || found.id === null) return "missing";
      if (file.size > limits.bytes) {
        notice = { kind: "tooLarge" };
        emit();
        return "tooLarge";
      }
      let source = found.source;
      if (source === null) {
        try {
          const response = await fetch(found.previewUrl);
          if (!response.ok) throw new Error("attachment_upload_failed");
          source = await response.blob();
        } catch {
          if (disposed || !stillThere(key)) return "missing";
          notice = { kind: "failed" };
          emit();
          return "failed";
        }
      }
      const current = items.find((item) => item.key === key);
      if (!current || disposed || current.uploading || current.id === null) return "missing";
      const previousId = current.id;
      current.uploading = true;
      notice = null;
      emit();
      try {
        const { id } = await port.upload(file);
        if (disposed || canceled.delete(key) || !stillThere(key)) {
          discard(id);
          discard(previousId);
          return "missing";
        }
        const next = items.find((item) => item.key === key);
        if (!next) {
          discard(id);
          discard(previousId);
          return "missing";
        }
        const previewUrl = URL.createObjectURL(file);
        const previousPreview = next.previewUrl;
        next.id = id;
        next.previewUrl = previewUrl;
        next.uploading = false;
        next.edited = true;
        next.source = source;
        emit();
        if (previousPreview !== previewUrl) revoke(previousPreview);
        discard(previousId);
        return "ok";
      } catch (error) {
        if (disposed || canceled.delete(key) || !stillThere(key)) {
          discard(previousId);
          return "missing";
        }
        const next = items.find((item) => item.key === key);
        if (next) next.uploading = false;
        notice = uploadNotice(error);
        emit();
        return notice.kind === "tooLarge" ? "tooLarge" : "failed";
      }
    },
    revertEdit: async (key) => {
      const found = items.find((item) => item.key === key);
      if (!found || disposed || found.uploading || found.id === null || found.source === null || !found.edited) return "missing";
      const source = found.source;
      const previousId = found.id;
      found.uploading = true;
      notice = null;
      emit();
      try {
        const { id } = await port.upload(source);
        if (disposed || canceled.delete(key) || !stillThere(key)) {
          discard(id);
          discard(previousId);
          return "missing";
        }
        const next = items.find((item) => item.key === key);
        if (!next) {
          discard(id);
          discard(previousId);
          return "missing";
        }
        const previewUrl = URL.createObjectURL(source);
        const previousPreview = next.previewUrl;
        next.id = id;
        next.previewUrl = previewUrl;
        next.uploading = false;
        next.edited = false;
        next.source = source;
        emit();
        if (previousPreview !== previewUrl) revoke(previousPreview);
        discard(previousId);
        return "ok";
      } catch (error) {
        if (disposed || canceled.delete(key) || !stillThere(key)) {
          discard(previousId);
          return "missing";
        }
        const next = items.find((item) => item.key === key);
        if (next) next.uploading = false;
        notice = uploadNotice(error);
        emit();
        return notice.kind === "tooLarge" ? "tooLarge" : "failed";
      }
    },
    noteSendFailure: (error, submittedIds) => {
      if (!isComposerAttachmentExpired(error)) return "other";
      const submitted = new Set(submittedIds);
      const gone = items.filter((item) => item.id !== null && submitted.has(item.id));
      items = items.filter((item) => item.id === null || !submitted.has(item.id));
      for (const item of gone) revoke(item.previewUrl);
      notice = { kind: "expired" };
      emit();
      return "expired";
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const item of items) {
        if (item.uploading) canceled.add(item.key);
        else if (item.id !== null) discard(item.id);
        revoke(item.previewUrl);
      }
      items = [];
      notice = null;
      snapshot = { items: [], uploading: false, notice: null };
      listeners.clear();
    },
  };
}
