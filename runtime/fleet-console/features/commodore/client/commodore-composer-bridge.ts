/**
 * 결정 한 줄(B+ 독)의 단추가 사령관 입력창의 글을 쓰는 길 — 독은 입력창과 다른 컴포넌트라 초안을 직접 읽지 못한다.
 * 입력창이 서 있는 동안 Theater별로 자기 초안을 읽고·비우고·초점을 받는 손잡이를 맡겨 두면, 단추가 그것으로 글을 가져간다.
 */

export interface ComposerDraftHandle {
  /** 지금 입력창 글 — 지휘관 참조 토큰은 평문으로 푼 값이고, `revision`은 비울 때 그새 고쳐졌는지 가르는 표식이다. */
  readonly read: () => { readonly text: string; readonly revision: number; readonly sending: boolean };
  /** `revision`의 글이 아직 그대로일 때만 비운다 — 보내는 동안 이어 쓴 글은 지키지 않는 일이 없다. */
  readonly clear: (revision: number) => void;
  readonly focus: () => void;
}

const handles = new Map<string, ComposerDraftHandle>();

/** 입력창이 서면 손잡이를 맡기고, 내려갈 때 거둔다(같은 Theater에 새 입력창이 이미 섰으면 건드리지 않는다). */
export function registerComposerDraft(theaterId: string, handle: ComposerDraftHandle): () => void {
  handles.set(theaterId, handle);
  return () => { if (handles.get(theaterId) === handle) handles.delete(theaterId); };
}

/**
 * 입력창에 쓴 글로 `send`를 한 번 부른다. 글이 비어 있으면 아무것도 보내지 않고 입력창으로 초점만 옮긴다(`"empty"`).
 * 앞선 글이 보내지는 중이면 겹쳐 보내지 않는다(`"busy"`). 보내기가 성공해야 글을 비우고, 실패하면 글은 그대로 남는다.
 */
export async function sendComposerText(theaterId: string, send: (text: string) => Promise<void>): Promise<"sent" | "empty" | "busy"> {
  const handle = handles.get(theaterId);
  const draft = handle?.read();
  const text = draft?.text.trim() ?? "";
  if (!handle || !draft || !text) { handle?.focus(); return "empty"; }
  if (draft.sending) return "busy";
  await send(text);
  handle.clear(draft.revision);
  return "sent";
}
