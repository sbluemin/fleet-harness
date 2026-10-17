import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { useSyncExternalStore } from "react";

import type { ComposerAttachments, ComposerAttachmentsSnapshot } from "./attachment-store.js";

/**
 * 붙여넣기·끌어놓기·파일 선택을 한 묶음으로 돌린다.
 * 표면이 하나라도 빠뜨리면 그 입구만 조용히 죽는다 — 그룹에서 끌어놓기가 빠졌던 자리다.
 */

export function useComposerAttachmentSnapshot(store: ComposerAttachments): ComposerAttachmentsSnapshot {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

export function useComposerAttachmentInput(
  store: ComposerAttachments,
  options?: {
    readonly disabled?: boolean;
    /** 이름이 없는 파일(붙여넣기)에 쓸 말. 없으면 스토어 기본을 쓴다. */
    readonly pastedName?: string;
    /** false면 올리지 않는다. 드롭의 기본 동작(내비게이션)은 그래도 막는다. */
    readonly accept?: (files: readonly File[]) => boolean;
  },
): {
  readonly dragOver: boolean;
  readonly onPaste: (event: ClipboardEvent) => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDragLeave: (event: DragEvent) => void;
  readonly onDrop: (event: DragEvent) => void;
  readonly pick: () => void;
  readonly fileInput: ReactNode;
} {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const disabled = options?.disabled === true;
  const pastedName = options?.pastedName;
  const accept = options?.accept;

  const add = (files: readonly File[]): void => {
    if (disabled) return;
    if (accept && !accept(files)) return;
    store.add(files, pastedName ? (file) => (file.name.trim().length > 0 ? file.name : pastedName) : undefined);
  };

  return {
    dragOver,
    onPaste: (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      if (!files.some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      add(files);
    },
    onDragOver: (event) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setDragOver(false);
    },
    onDrop: (event) => {
      setDragOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    },
    pick: () => {
      if (!disabled) inputRef.current?.click();
    },
    fileInput: (
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    ),
  };
}
