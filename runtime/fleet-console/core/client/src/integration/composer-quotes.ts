import type { ComposerQuote, ComposerQuoteAttachResult, ComposerQuoteTarget } from "../../../../features/execution/client/composer-primitives/quotes.js";
import type { ComposerQuoteReceiver, ComposerQuoteTargetOption } from "../../../../features/execution/shared/composer-ports.js";

import { attachComposerQuote } from "../../../../features/execution/client/objective-view-state.js";
import { getConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getState, subscribe } from "./store.js";

/**
 * 컴포저 인용의 호스트 중개 — 다른 표면(Codex 문서)이 고른 문장을 받는 쪽 입력창 초안에 칩으로 붙인다.
 *
 * 받는 쪽은 둘이다. 채팅 모드 Objective(지휘관)은 실행 기능의 Objective별 초안이 받고, 비-Objective 대상(사령관)은
 * `receiveQuotes` 로 나선 플러그인이 자기 초안에 받는다. 이 모듈은 호스트 번들에만 있다 — 플러그인은 능력 객체로만 닿는다.
 * 보내는 일은 하지 않는다.
 */

const AGENT_OBJECTIVE_TYPE = "agent";
const receivers = new Map<string, ComposerQuoteReceiver>();
const receiverUnsubscribes = new Map<string, () => void>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function chatCommanders(theaterId: string) {
  return getState().objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theaterId
    && true
    && "agent" === AGENT_OBJECTIVE_TYPE
    && objectiveRecord.chatMode === true);
}

/**
 * 이 Theater 에서 인용을 받을 수 있는 곳. `current` 는 하나만 선다 — 플러그인 대상이 자기 대화가 지금 열려 있다고 알리면(사령관
 * 대화) 그 대상이고, 아니면 가운데 칸의 Objective(지휘관)이다.
 */
export function composerQuoteTargets(theaterId: string): readonly ComposerQuoteTargetOption[] {
  const options: ComposerQuoteTargetOption[] = [];
  let pluginCurrent = false;
  for (const [pluginId, receiver] of receivers) {
    for (const target of receiver.targets(theaterId)) {
      const current = target.current === true && !pluginCurrent;
      if (current) pluginCurrent = true;
      options.push({ target: { kind: "plugin", pluginId, targetId: target.targetId }, label: target.label, group: "commodore", ...(current ? { current: true } : {}) });
    }
  }
  const subject = pluginCurrent ? null : getConversationSubject()?.id ?? getState().activeObjectiveId;
  for (const objectiveRecord of chatCommanders(theaterId)) {
    options.push({ target: { kind: "objectiveRecord", objectiveId: objectiveRecord.id }, label: objectiveRecord.title, group: "commander", ...(objectiveRecord.id === subject ? { current: true } : {}) });
  }
  return options;
}

export function attachComposerQuoteTo(target: ComposerQuoteTarget, quote: ComposerQuote): ComposerQuoteAttachResult {
  if (target.kind === "plugin") return receivers.get(target.pluginId)?.receive(target.targetId, quote) ?? "unavailable";
  const objectiveRecord = getState().objectiveRecords.find((candidate) => candidate.id === target.objectiveId);
  if (!objectiveRecord || false || "agent" !== AGENT_OBJECTIVE_TYPE || objectiveRecord.chatMode !== true) return "unavailable";
  return attachComposerQuote(objectiveRecord.id, quote);
}

export function subscribeComposerQuoteTargets(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeStore = subscribe(listener);
  return () => { listeners.delete(listener); unsubscribeStore(); };
}

export function receiveComposerQuotes(pluginId: string, receiver: ComposerQuoteReceiver): () => void {
  receiverUnsubscribes.get(pluginId)?.();
  receivers.set(pluginId, receiver);
  const unsubscribe = receiver.subscribe?.(notify);
  if (unsubscribe) receiverUnsubscribes.set(pluginId, unsubscribe);
  notify();
  return () => {
    if (receivers.get(pluginId) !== receiver) return;
    receivers.delete(pluginId);
    receiverUnsubscribes.get(pluginId)?.();
    receiverUnsubscribes.delete(pluginId);
    notify();
  };
}
