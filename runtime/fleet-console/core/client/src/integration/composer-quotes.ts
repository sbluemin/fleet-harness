import type { ComposerQuote, ComposerQuoteAttachResult, ComposerQuoteTarget } from "@fleet-console/sdk/composer/quotes";
import type { ComposerQuoteReceiver, ComposerQuoteTargetOption } from "@fleet-console/sdk/plugin";

import { attachComposerQuote } from "../../../../features/execution/client/operation-view-state.js";
import { getConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { getState, subscribe } from "./store.js";

/**
 * 컴포저 인용의 호스트 중개 — 다른 표면(Codex 문서)이 고른 문장을 받는 쪽 입력창 초안에 칩으로 붙인다.
 *
 * 받는 쪽은 둘이다. 채팅 모드 Operation(지휘관)은 실행 기능의 Operation별 초안이 받고, 비-Operation 대상(사령관)은
 * `receiveQuotes` 로 나선 플러그인이 자기 초안에 받는다. 이 모듈은 호스트 번들에만 있다 — 플러그인은 능력 객체로만 닿는다.
 * 보내는 일은 하지 않는다.
 */

const AGENT_OPERATION_TYPE = "agent";
const receivers = new Map<string, ComposerQuoteReceiver>();
const receiverUnsubscribes = new Map<string, () => void>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function chatCommanders(theaterId: string) {
  return getState().operations.filter((operation) => operation.theaterId === theaterId
    && operation.pluginId === null
    && operation.type === AGENT_OPERATION_TYPE
    && operation.payload.chatMode === true);
}

export function composerQuoteTargets(theaterId: string): readonly ComposerQuoteTargetOption[] {
  const options: ComposerQuoteTargetOption[] = [];
  for (const [pluginId, receiver] of receivers) {
    for (const target of receiver.targets(theaterId)) {
      options.push({ target: { kind: "plugin", pluginId, targetId: target.targetId }, label: target.label, group: "commodore" });
    }
  }
  const subject = getConversationSubject()?.id ?? getState().activeOperationId;
  for (const operation of chatCommanders(theaterId)) {
    options.push({ target: { kind: "operation", operationId: operation.id }, label: operation.title, group: "commander", ...(operation.id === subject ? { current: true } : {}) });
  }
  return options;
}

export function attachComposerQuoteTo(target: ComposerQuoteTarget, quote: ComposerQuote): ComposerQuoteAttachResult {
  if (target.kind === "plugin") return receivers.get(target.pluginId)?.receive(target.targetId, quote) ?? "unavailable";
  const operation = getState().operations.find((candidate) => candidate.id === target.operationId);
  if (!operation || operation.pluginId !== null || operation.type !== AGENT_OPERATION_TYPE || operation.payload.chatMode !== true) return "unavailable";
  return attachComposerQuote(operation.id, quote);
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
