import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import type { OperationCluster } from "@fleet-console/sdk/plugin";

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
 *    탭 본문은 `useConversationSubject()` 로 지금 가운데 칸의 Operation 을, `useConversationStandIn()` 으로 플러그인 대화가
 *    대신하는 아직 서지 않은 Operation 을 읽는다.
 * 3. 사이드바 행 미리보기 — `setConversationPreviewSource`. 원천이 없거나 값이 없으면 행은 상태 문구를 보인다.
 * 4. 대화 머리 보기 스위치 — `setConversationCaptionRenderer`. 본문 렌더러가 세운 화면의 보기 스위치(그룹 대화의 「턴 접기」)가
 *    pill 바로 옆 보기 캡슐(전환과 한 묶음)에 선다. `null` 이면 그 칸은 서지 않는다.
 * 5. 대신하는 Operation 의 입력창 — `setConversationStandInComposer`. 플러그인 대화가 아직 서지 않은 Operation 을 대신하면
 *    그 대화의 문맥(`ConversationSurfaceContext.composer`)으로 건넨다.
 * 6. 머리 pill 의 잠깐 바뀐 내용 — `publishConversationPillTakeover`. 본문이 덮는 화면(그룹 대화의 전언 대화 화면)이 그 대화의 주인
 *    Operation 머리 pill(데스크톱 맨 위 줄·모바일 상단 막대)을 제 내용으로 바꾼다. pill 을 그리는 쪽은 `useConversationPillTakeover` 로
 *    읽으며 자기가 그 Operation 의 pill 을 세웠다고 알리고, 본문은 `useConversationPillHosted` 로 그 pill 이 있는지 보고 없으면 제 안에 대체 칩을 둔다.
 *
 * 모두 호스트 번들 안의 소비자 몫이다. 플러그인 번들은 모듈 사본이 갈릴 수 있어 여기에 등록하지 않는다.
 */

// ── 가운데 칸의 주인 ───────────────────────────────────────────────────────

/** 가운데 칸에 지금 선 Operation. 비어 있으면 null. 셸이 정하고 탭·렌더러가 읽는다. */
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

// ── 가운데 칸이 대신하는 Operation ─────────────────────────────────────────

/**
 * 가운데 칸의 플러그인 대화가 대신하는, 아직 서지 않은 Operation 의 id(`ConversationSurfaceDescriptor.standInOperationId`).
 * 있으면 오른쪽 패널은 Operation 대화처럼 선다(글자 탭·「구성원」). Operation 대화나 다른 플러그인 대화가 서면 null 이다.
 */
let standIn: string | null = null;
const standInListeners = new Set<() => void>();

export function publishConversationStandIn(next: string | null): void {
  if (standIn === next) return;
  standIn = next;
  for (const listener of standInListeners) listener();
}

export function getConversationStandIn(): string | null {
  return standIn;
}

export function subscribeConversationStandIn(listener: () => void): () => void {
  standInListeners.add(listener);
  return () => { standInListeners.delete(listener); };
}

export function useConversationStandIn(): string | null {
  return useSyncExternalStore(subscribeConversationStandIn, () => standIn, () => null);
}

// ── 목표 묶음 ─────────────────────────────────────────────────────────────

/**
 * 셸이 읽은 목표 묶음 — 탭 본문이 아바타 얼굴의 검토 대기·결정 요청·임무 완료를 다른 표면과 같은 사실로 고르게 한다.
 * 탭은 묶음 훅(플러그인 레지스트리)을 직접 가져오지 않고 이 자리에서 읽는다.
 */
let clusters: readonly OperationCluster[] = [];
const clusterListeners = new Set<() => void>();

export function publishConversationClusters(next: readonly OperationCluster[]): void {
  if (clusters === next) return;
  clusters = next;
  for (const listener of clusterListeners) listener();
}

export function useConversationClusters(): readonly OperationCluster[] {
  return useSyncExternalStore(
    (listener) => { clusterListeners.add(listener); return () => { clusterListeners.delete(listener); }; },
    () => clusters,
    () => clusters,
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
  /** 기본 본문 대신 세운 글의 파일 링크 열기 — 기본 본문(Operation 본문)이 받는 것과 같은 창구. */
  readonly navigate: ClientNavigateCapability;
  /** 이 대화의 Operation 브라우저 칸을 연다(여는 일만) — 기본 본문의 링크 카드 「Operation 브라우저」 행과 같은 자리. 본문 Operation 이 브라우저를 내주지 않으면 없다. */
  readonly openOperationBrowser?: () => void;
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

// ── 대화 머리 보기 스위치 ──────────────────────────────────────────────────

/** 머리 보기 스위치 렌더러의 맥락 — 본문 렌더러와 같은 사실이다(기본 본문은 없다). */
export type ConversationCaptionContext = Omit<ConversationBodyContext, "defaultBody" | "navigate" | "openOperationBrowser">;
export type ConversationCaptionRenderer = (context: ConversationCaptionContext) => ReactNode | null;

let captionRenderer: ConversationCaptionRenderer | null = null;
const captionListeners = new Set<() => void>();

/** 대화 머리 보기 스위치 렌더러를 둔다. 하나만 선다 — 나중 등록이 이긴다. 돌려준 함수로 걷는다. */
export function setConversationCaptionRenderer(renderer: ConversationCaptionRenderer): () => void {
  captionRenderer = renderer;
  for (const listener of captionListeners) listener();
  return () => {
    if (captionRenderer !== renderer) return;
    captionRenderer = null;
    for (const listener of captionListeners) listener();
  };
}

export function useConversationCaptionRenderer(): ConversationCaptionRenderer | null {
  return useSyncExternalStore(
    (listener) => { captionListeners.add(listener); return () => { captionListeners.delete(listener); }; },
    () => captionRenderer,
    () => null,
  );
}

// ── 대신하는 Operation 의 입력창 ──────────────────────────────────────────

/** 플러그인 대화가 대신하는 Operation(시작 전·완료한 목표)의 입력창 렌더러 — 그 id 의 묶음 대화 계약으로 그린다. */
export type ConversationStandInComposerRenderer = (operationId: string, language: "en" | "ko") => ReactNode;

let standInComposer: ConversationStandInComposerRenderer | null = null;
const standInComposerListeners = new Set<() => void>();

/** 대신하는 Operation 의 입력창 렌더러를 둔다. 하나만 선다 — 나중 등록이 이긴다. 돌려준 함수로 걷는다. */
export function setConversationStandInComposer(renderer: ConversationStandInComposerRenderer): () => void {
  standInComposer = renderer;
  for (const listener of standInComposerListeners) listener();
  return () => {
    if (standInComposer !== renderer) return;
    standInComposer = null;
    for (const listener of standInComposerListeners) listener();
  };
}

export function useConversationStandInComposer(): ConversationStandInComposerRenderer | null {
  return useSyncExternalStore(
    (listener) => { standInComposerListeners.add(listener); return () => { standInComposerListeners.delete(listener); }; },
    () => standInComposer,
    () => null,
  );
}

// ── Operation 이름 변경 ────────────────────────────────────────────────────

type ConversationOperationRename = (operationId: string, title: string) => void;

let operationRename: ConversationOperationRename | null = null;
const operationRenameListeners = new Set<() => void>();

/** 오른쪽 패널 머리의 이름 편집이 확정할 길 — Operation 목록을 가진 쪽이 사이드바 칩과 같은 이름 변경 핸들러를 둔다. 돌려준 함수로 걷는다. */
export function setConversationOperationRename(rename: ConversationOperationRename): () => void {
  operationRename = rename;
  for (const listener of operationRenameListeners) listener();
  return () => {
    if (operationRename !== rename) return;
    operationRename = null;
    for (const listener of operationRenameListeners) listener();
  };
}

export function useConversationOperationRename(): ConversationOperationRename | null {
  return useSyncExternalStore(
    (listener) => { operationRenameListeners.add(listener); return () => { operationRenameListeners.delete(listener); }; },
    () => operationRename,
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

// ── 머리 pill 의 잠깐 바뀐 내용 ────────────────────────────────────────────

/**
 * 머리 pill 을 잠깐 대신하는 내용 — 그룹 대화의 전언 대화 화면이 열린 동안 「보낸 이 ⇄ 받는 이」. pill 을 그리는 쪽은 이 내용을
 * 제목 단추로 감싸지 않는다(안의 단추는 내용이 소유한다). `key` 가 바뀌면 내용이 바뀐 것이다 — 크로스페이드·폭 전환의 기준이다.
 */
export interface ConversationPillTakeover {
  readonly key: string;
  /** 바뀐 pill 무리의 접근성 이름. */
  readonly label: string;
  readonly content: ReactNode;
}

const pillTakeovers = new Map<string, ConversationPillTakeover>();
const pillHosts = new Map<string, number>();
const pillListeners = new Set<() => void>();
const subscribePill = (listener: () => void) => { pillListeners.add(listener); return () => { pillListeners.delete(listener); }; };
const emitPill = () => { for (const listener of pillListeners) listener(); };

/** 그 Operation 의 머리 pill 을 바꾸거나(`takeover`) 되돌린다(`null`). 바꾼 쪽이 걷힐 때 null 로 되돌린다. */
export function publishConversationPillTakeover(operationId: string, takeover: ConversationPillTakeover | null): void {
  if ((pillTakeovers.get(operationId) ?? null) === takeover) return;
  if (takeover) pillTakeovers.set(operationId, takeover); else pillTakeovers.delete(operationId);
  emitPill();
}

/** 머리 pill 을 그리는 쪽 — 그 Operation 의 바뀐 내용을 읽고, 서 있는 동안 자기가 그 pill 을 세웠다고 알린다. */
export function useConversationPillTakeover(operationId: string | null): ConversationPillTakeover | null {
  useEffect(() => {
    if (operationId === null) return;
    pillHosts.set(operationId, (pillHosts.get(operationId) ?? 0) + 1);
    emitPill();
    return () => {
      const count = (pillHosts.get(operationId) ?? 1) - 1;
      if (count > 0) pillHosts.set(operationId, count); else pillHosts.delete(operationId);
      emitPill();
    };
  }, [operationId]);
  return useSyncExternalStore(subscribePill, () => (operationId === null ? null : pillTakeovers.get(operationId) ?? null), () => null);
}

/** 그 Operation 의 머리 pill 이 지금 서 있는가 — 없으면 바꿀 pill 이 없으므로 본문이 제 안에 대체 칩을 둔다. */
export function useConversationPillHosted(operationId: string | null): boolean {
  return useSyncExternalStore(subscribePill, () => operationId !== null && (pillHosts.get(operationId) ?? 0) > 0, () => false);
}
