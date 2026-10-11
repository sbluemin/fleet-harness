import { useSyncExternalStore, type ReactNode } from "react";

import type { OperationNode } from "../../../../core/client/src/integration/types.js";

export {
  registerConversationOperationTab,
  type ConversationOperationTab,
} from "../../../../core/client/src/chrome/rail/operation-tabs.js";

/**
 * 대화 중심 화면에 다른 기능이 끼워 넣는 자리 세 가지.
 *
 * 1. 가운데 칸 본문 — `setConversationBodyRenderer`. 기본은 그 Operation 의 기존 본문(채팅·터미널)이다. 렌더러가
 *    `null` 을 돌려주면 기본 본문이 선다. 그룹 대화는 구성원을 가진 Operation 에서만 자기 화면을 돌려주면 된다.
 * 2. 오른쪽 패널 앞 묶음 — `registerConversationOperationTab`(core 레일). 탭은 레일 패널로 서서 독점 슬롯·폭 기억을 받는다.
 *    탭 본문은 `useConversationSubject()` 로 지금 가운데 칸의 Operation 을 읽는다.
 * 3. 사이드바 행 미리보기 — `setConversationPreviewSource`. 원천이 없거나 값이 없으면 행은 상태 문구를 보인다.
 *
 * 모두 호스트 번들 안의 소비자 몫이다. 플러그인 번들은 모듈 사본이 갈릴 수 있어 여기에 등록하지 않는다.
 */

// ── 가운데 칸의 주인 ───────────────────────────────────────────────────────

/** 가운데 칸에 지금 선 Operation(War Room 이면 무대). 비어 있으면 null. 셸이 정하고 탭·렌더러가 읽는다. */
let subject: OperationNode | null = null;
const subjectListeners = new Set<() => void>();

export function publishConversationSubject(next: OperationNode | null): void {
  if (subject === next) return;
  subject = next;
  for (const listener of subjectListeners) listener();
}

export function getConversationSubject(): OperationNode | null {
  return subject;
}

/** 가운데 칸의 주인이 바뀔 때 부른다 — 훅을 쓸 수 없는 모듈 수준 소비자(탭 등록 여부)용. */
export function subscribeConversationSubject(listener: () => void): () => void {
  subjectListeners.add(listener);
  return () => { subjectListeners.delete(listener); };
}

export function useConversationSubject(): OperationNode | null {
  return useSyncExternalStore(
    (listener) => { subjectListeners.add(listener); return () => { subjectListeners.delete(listener); }; },
    () => subject,
    () => null,
  );
}

// ── 가운데 칸 본문 ─────────────────────────────────────────────────────────

export interface ConversationBodyContext {
  /** 가운데 칸의 주인 — 구성원을 가진 목표면 지휘관이다. */
  readonly operation: OperationNode;
  /** 지금 본문을 보이는 Operation — 오른쪽 「구성원」 탭에서 구성원을 고르면 그 구성원, 아니면 주인. */
  readonly bodyOperation: OperationNode;
  /** 주인의 구성원(코어의 부모 관계). 없으면 빈 배열. */
  readonly nestedOperations: readonly OperationNode[];
  readonly language: "en" | "ko";
  /** 셸이 그릴 기본 본문 — 렌더러가 감싸 쓰거나 무시한다. 같은 렌더에서 두 번 그리지 않는다. */
  readonly defaultBody: ReactNode;
}

export type ConversationBodyRenderer = (context: ConversationBodyContext) => ReactNode | null;

let bodyRenderer: ConversationBodyRenderer | null = null;
const bodyListeners = new Set<() => void>();

/** 가운데 칸 본문 렌더러를 둔다. 하나만 선다 — 나중 등록이 이긴다. 돌려준 함수로 걷는다. */
export function setConversationBodyRenderer(renderer: ConversationBodyRenderer): () => void {
  bodyRenderer = renderer;
  for (const listener of bodyListeners) listener();
  return () => {
    if (bodyRenderer !== renderer) return;
    bodyRenderer = null;
    for (const listener of bodyListeners) listener();
  };
}

export function useConversationBodyRenderer(): ConversationBodyRenderer | null {
  return useSyncExternalStore(
    (listener) => { bodyListeners.add(listener); return () => { bodyListeners.delete(listener); }; },
    () => bodyRenderer,
    () => null,
  );
}

// ── 사이드바 행 미리보기 ───────────────────────────────────────────────────

export interface ConversationRowPreview {
  readonly text: string;
}

export interface ConversationPreviewSource {
  readonly subscribe: (listener: () => void) => () => void;
  /** 행 id 로 미리보기를 찾는다. 같은 값이면 같은 참조를 돌려줘야 한다(useSyncExternalStore). */
  readonly get: (operationId: string) => ConversationRowPreview | null;
}

let previewSource: ConversationPreviewSource | null = null;
const previewSourceListeners = new Set<() => void>();
const NO_PREVIEW_SOURCE: ConversationPreviewSource = { subscribe: () => () => undefined, get: () => null };

/** 미리보기 원천을 둔다(그룹 타임라인 계약이 들어오면 그쪽이 부른다). 돌려준 함수로 걷는다. */
export function setConversationPreviewSource(source: ConversationPreviewSource): () => void {
  previewSource = source;
  for (const listener of previewSourceListeners) listener();
  return () => {
    if (previewSource !== source) return;
    previewSource = null;
    for (const listener of previewSourceListeners) listener();
  };
}

/** 행 하나의 미리보기 — 원천이 없으면 늘 null 이다. 행은 그때 상태 문구를 보인다. */
export function useConversationRowPreview(operationId: string): ConversationRowPreview | null {
  const source = useSyncExternalStore(
    (listener) => { previewSourceListeners.add(listener); return () => { previewSourceListeners.delete(listener); }; },
    () => previewSource ?? NO_PREVIEW_SOURCE,
    () => NO_PREVIEW_SOURCE,
  );
  return useSyncExternalStore(source.subscribe, () => source.get(operationId), () => null);
}
