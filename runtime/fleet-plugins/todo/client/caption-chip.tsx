import { useSyncExternalStore } from "react";

import type { OperationCaptionContributionContext } from "@fleet-console/sdk/plugin";

import { getT } from "./i18n/index.js";
import { findSlotOf, openTodoSurface, revealItem, subscribeTodo } from "./todo-state.js";

/**
 * 슬롯에 든 Operation 의 캡션에 얹는 「조율자 · 할 일」 / 「단계 n · 단계 이름 › 할 일」 칩과, 사이드바 칩의 12px 표식.
 * 누르면 할 일 표면이 열리고 그 항목·단계가 선택된다. 슬롯이 비면 칩도 사라진다 — 같은 스토어를 구독하므로 그 자리에서.
 */
function slotKey(operationId: string): string | null {
  const slot = findSlotOf(operationId);
  return slot ? `${slot.item.id}|${slot.stepId ?? ""}|${slot.item.updatedAt}` : null;
}

export function TodoCaptionChip({ operation, language, surface }: OperationCaptionContributionContext) {
  // 스냅샷은 참조가 안정된 문자열 키다 — 객체를 돌려주면 useSyncExternalStore 가 매 렌더 새 값으로 보고 되돌이표를 돈다.
  const key = useSyncExternalStore(subscribeTodo, () => slotKey(operation.id), () => slotKey(operation.id));
  if (!key) return null;
  const slot = findSlotOf(operation.id);
  if (!slot) return null;
  const t = getT(language);
  const { item, stepId } = slot;
  const step = stepId ? item.steps.find((candidate) => candidate.id === stepId) ?? null : null;
  const index = step ? item.steps.indexOf(step) + 1 : 0;
  const role = step ? t("todo.caption.step", { index }) : t("todo.caption.coordinator");
  const text = step ? `${step.text} › ${item.title}` : item.title;
  const go = () => { revealItem({ itemId: item.id, ...(stepId ? { stepId } : {}) }); openTodoSurface(); };
  // 담당 세션이 있으면 묶음(사이드바 들여쓰기·캔버스 대형·단계 띠)이 소속을 말한다 — 칩은 묶음이 서지 못한 슬롯(담당 없는 조율자)에만 남는다.
  if (stepId || item.steps.some((candidate) => candidate.slot && candidate.slot.operationId !== item.slot?.operationId)) return null;
  if (surface === "chip") {
    return (
      <button type="button" className="todo-glyph todo-caption-mark" title={`${role} · ${text}`} aria-label={t("todo.caption.goto")} onClick={(event) => { event.stopPropagation(); go(); }}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true"><path d="M3 4.5l1.2 1.2 2-2.4M3 9.5l1.2 1.2 2-2.4M8.5 4.5H13M8.5 9.5H13" /></svg>
      </button>
    );
  }
  return (
    <button type="button" className="todo-caption-chip" title={`${role} · ${text}`} aria-label={t("todo.caption.goto")} onClick={(event) => { event.stopPropagation(); go(); }}>
      <b>{role}</b>
      <span>{text}</span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}
