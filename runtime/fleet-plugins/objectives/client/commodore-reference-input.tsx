import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CompositionEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { AgentChatReferenceHost } from "@fleet-console/sdk/components/agent-chat-transcript";
import { CONVERSATION_REFERENCE_MARK } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective } from "../server/types.js";
import { commanderMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { useObjectiveTheater, useOperationSummaries } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관 입력의 '@' 지휘관 참조(목표 8d9a400b 시안 A · 본문 인라인 토큰).
 *
 * 고른 지휘관(목표)은 본문의 그 자리에 원자 토큰(작은 아바타 + 제목)으로 박힌다. 받는 이는 그대로 사령관이고 지휘관은 맥락이다.
 * 값은 평문 + 참조 목록이다 — 본문은 토큰 자리마다 표식 글자(SDK `CONVERSATION_REFERENCE_MARK`, U+FFFC) 하나를 싣고, 목록은 그 순서다.
 * 사람이 친 글자·붙여넣은 글자에서는 표식 글자를 지우므로 표식은 토큰에서만 나온다. 서버는 표식 수와 참조 수의 짝, 각 목표가 같은
 * Theater 의 실재 목표인지를 다시 검증한다(권위는 서버다).
 *
 * 입력은 contenteditable 이다 — textarea 는 문장 속 토큰을 품지 못한다. 그래서 브라우저가 고르는 편집 모양을 좁힌다: 붙여넣기·끌어
 * 놓기는 평문만, 서식 명령은 받지 않고, 문단 나눔은 줄바꿈(`<br>`) 하나로 바꾼다. 토큰은 `contenteditable=false` 라 커서가 안에 들지
 * 않고, 토큰 바로 뒤(앞)의 Backspace(Delete)는 토큰을 통째로 지운다. DOM 이 값의 원본이고, 바깥 값이 우리가 낸 값과 다를 때만
 * (보낸 뒤 비우기·초안 복원) DOM 을 다시 세운다 — 조합 중인 글자와 커서를 건드리지 않기 위해서다.
 *
 * '@' 는 채팅 컴포저 덱(`composer-deck.ts` readAgentToken)과 같은 규칙으로 깬다: 문두나 공백(토큰·줄바꿈 뒤 포함) 뒤의 '@' 이고, 커서까지
 * 공백·'@' 가 섞이면 눕는다. 목록은 같은 Theater 의 목표 전부(완료는 「완료됨」 묶음)이고 질의로 좁힌다. 한 메시지의 참조는 셋까지이고,
 * 이미 붙은 지휘관은 다시 붙지 않는다. 선택 행은 배경 워시로만 말한다(왼쪽 띠 없음).
 */

/** 한 메시지의 참조 상한 — 서버 `MAX_COMMODORE_REFERENCES` 와 같은 값이다(서버가 넘는 요청을 거절한다). */
export const MAX_COMMODORE_REFERENCES = 3;
/** 목록이 한 번에 세우는 행 — 완료까지 전부 싣되 질의 없이 수백 줄을 그리지 않는다. 나머지는 질의로 찾는다. */
const MAX_ROWS = 40;

export interface CommodoreReference {
  readonly id: string;
  readonly title: string;
}
export interface CommodoreReferenceValue {
  readonly text: string;
  readonly references: readonly CommodoreReference[];
}
export const EMPTY_REFERENCE_VALUE: CommodoreReferenceValue = { text: "", references: [] };

export interface CommodoreReferenceInputHandle {
  focus: (options?: FocusOptions) => void;
  /** + 메뉴 「지휘관 참조」·모바일 @ 원 — 커서 자리에 '@' 를 넣어 목록을 연다. */
  openReferences: () => void;
}

export interface CommodoreReferenceInputProps {
  readonly t: T;
  readonly theaterId: string;
  readonly value: CommodoreReferenceValue;
  readonly onChange: (value: CommodoreReferenceValue) => void;
  readonly disabled?: boolean;
  readonly className: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly ariaDescribedBy?: string;
  /** 폰 화면 — 목록 행이 엄지 높이(46px)가 되고 모바일 토큰 색을 쓴다. */
  readonly phone?: boolean;
  /** 목록이 열려 있지 않을 때의 키 — 보내기·/clear 확인. 처리했으면 preventDefault 한다. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onKeyUp?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onBlur?: () => void;
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: () => void;
  /** 붙여넣거나 끌어 놓은 이미지 — 받는 쪽이 없으면 이미지는 버린다. */
  readonly onFiles?: (files: readonly File[]) => void;
  readonly isFile?: (file: File) => boolean;
}

/* ── 순수 판정 ─────────────────────────────────────────────────────── */

/** 채팅 컴포저 덱의 '@' 규칙(readAgentToken)과 같다 — 같은 글자에 두 규칙을 두면 표면마다 다르게 눕는다. */
export function readReferenceToken(value: string, caret: number): { readonly at: number; readonly query: string } | null {
  const at = value.lastIndexOf("@", caret - 1);
  if (at < 0 || at >= caret) return null;
  if (at > 0 && !/\s/.test(value[at - 1] ?? "")) return null;
  const query = value.slice(at + 1, caret);
  if (/[\s@]/.test(query)) return null;
  return { at, query };
}

const sameValue = (a: CommodoreReferenceValue, b: CommodoreReferenceValue) =>
  a.text === b.text && a.references.length === b.references.length && a.references.every((reference, index) => reference.id === b.references[index]?.id);

const stripMarks = (text: string) => text.split(CONVERSATION_REFERENCE_MARK).join("");

const TOKEN_CLASS = "objectives-commodore-ref";

function isToken(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.refId !== undefined;
}

/**
 * DOM → 값. 글자 노드는 표식을 지운 글자, 토큰은 표식 하나, `<br>` 은 줄바꿈이다. 루트의 마지막 `<br>` 은 브라우저가 빈 끝 줄에
 * 커서를 세우려고 두는 자리표라 세지 않는다. 브라우저가 문단을 블록으로 나눴으면(붙여넣기 실행 취소 등) 블록 앞에 줄바꿈을 둔다.
 */
function serialize(root: HTMLElement): CommodoreReferenceValue {
  let text = "";
  const references: CommodoreReference[] = [];
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { text += stripMarks((child as Text).data); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const element = child as HTMLElement;
      if (isToken(element)) {
        text += CONVERSATION_REFERENCE_MARK;
        references.push({ id: element.dataset.refId!, title: element.dataset.refTitle ?? "" });
        return;
      }
      if (element.tagName === "BR") { if (!(parent === root && element === root.lastChild)) text += "\n"; return; }
      if ((element.tagName === "DIV" || element.tagName === "P") && text && !text.endsWith("\n")) text += "\n";
      walk(element);
    });
  };
  walk(root);
  return { text, references };
}

function tokenNode(t: T, reference: CommodoreReference): HTMLElement {
  const token = document.createElement("span");
  token.className = TOKEN_CLASS;
  token.contentEditable = "false";
  token.dataset.refId = reference.id;
  token.dataset.refTitle = reference.title;
  token.setAttribute("aria-label", t("objectives.commodore.reference.token", { title: reference.title }));
  const mark = document.createElement("span");
  mark.className = `${TOKEN_CLASS}-mark`;
  mark.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = `${TOKEN_CLASS}-label`;
  label.textContent = reference.title;
  token.append(mark, label);
  return token;
}

/** 값 → DOM. 짝이 없는 표식은 버린다. 끝이 줄바꿈이면 그 빈 줄에 커서가 서도록 자리표 `<br>` 하나를 더 둔다. */
function build(root: HTMLElement, t: T, value: CommodoreReferenceValue): void {
  root.replaceChildren();
  let index = 0;
  const lines = value.text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) root.append(document.createElement("br"));
    line.split(CONVERSATION_REFERENCE_MARK).forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) {
        const reference = value.references[index];
        index += 1;
        if (reference) root.append(tokenNode(t, reference));
      }
      if (piece) root.append(document.createTextNode(piece));
    });
  });
  if (value.text.endsWith("\n")) root.append(document.createElement("br"));
}

function placeCaretAtEnd(root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretInside(root: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) ? range : null;
}

/** 커서 앞 '@' 질의 — 커서가 글자 노드 안에 접혀 있을 때만이다. 토큰·줄바꿈 바로 뒤의 '@' 는 그 노드의 첫 글자라 문두로 읽힌다. */
function caretToken(root: HTMLElement): { readonly node: Text; readonly at: number; readonly end: number; readonly query: string } | null {
  const range = caretInside(root);
  if (!range || !range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const node = range.startContainer as Text;
  const before = node.data.slice(0, range.startOffset);
  const token = readReferenceToken(before, before.length);
  return token ? { node, at: token.at, end: range.startOffset, query: token.query } : null;
}

/** 접힌 커서 바로 앞(뒤) 노드가 토큰이면 그 토큰. 글자 노드 한가운데면 없다. */
function tokenBesideCaret(root: HTMLElement, forward: boolean): HTMLElement | null {
  const range = caretInside(root);
  if (!range || !range.collapsed) return null;
  const { startContainer: container, startOffset: offset } = range;
  let sibling: Node | null;
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container as Text;
    if (forward ? offset < text.length : offset > 0) return null;
    sibling = forward ? text.nextSibling : text.previousSibling;
  } else sibling = forward ? container.childNodes[offset] ?? null : container.childNodes[offset - 1] ?? null;
  return isToken(sibling) ? (sibling as HTMLElement) : null;
}

/* ── 목록 ─────────────────────────────────────────────────────────── */

type RowStatus = "running" | "decision" | "review" | "pending" | "missionsDone" | "done";
interface Candidate {
  readonly objective: Objective;
  readonly status: RowStatus;
}

function rowStatus(objective: Objective): RowStatus {
  if (objective.done) return "done";
  if (objective.decisionRequest) return "decision";
  if (objective.awaitingReview) return "review";
  if (!objective.commenced) return "pending";
  if (objective.awaitingHandoff) return "missionsDone";
  return "running";
}

/** 같은 Theater 의 목표 전부 — 진행 중 묶음이 먼저, 완료는 뒤 「완료됨」 묶음. 질의는 제목(대소문자 무시)이나 id 머리로 좁힌다. */
function candidatesOf(objectives: readonly Objective[], query: string): readonly Candidate[] {
  const needle = query.trim().toLowerCase();
  const matched = objectives.filter((objective) => !objective.removed && (!needle || objective.title.toLowerCase().includes(needle) || objective.id.toLowerCase().startsWith(needle)));
  const rows = matched.map((objective) => ({ objective, status: rowStatus(objective) }));
  return [...rows.filter((row) => row.status !== "done"), ...rows.filter((row) => row.status === "done")].slice(0, MAX_ROWS);
}

/* ── 입력 ─────────────────────────────────────────────────────────── */

interface ListState {
  readonly open: boolean;
  readonly query: string;
  readonly index: number;
}
const CLOSED: ListState = { open: false, query: "", index: 0 };

export const CommodoreReferenceInput = forwardRef<CommodoreReferenceInputHandle, CommodoreReferenceInputProps>(function CommodoreReferenceInput(props, ref) {
  const { t, theaterId, value, onChange, disabled = false, className, placeholder, ariaLabel, ariaDescribedBy, phone = false } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const emitted = useRef<CommodoreReferenceValue | null>(null);
  const composing = useRef(false);
  const pendingPick = useRef<Objective | null>(null);
  /** Esc 로 닫은 '@' 자리 — 질의가 그 자리에 있는 동안은 다시 열지 않는다. */
  const dismissed = useRef<{ node: Text; at: number } | null>(null);
  const [list, setList] = useState<ListState>(CLOSED);
  const [slots, setSlots] = useState<readonly { readonly node: HTMLElement; readonly id: string }[]>([]);
  const listId = useId();
  const latest = useRef(props);
  latest.current = props;

  const { objectives } = useObjectiveTheater(theaterId);
  const candidates = useMemo(() => (list.open ? candidatesOf(objectives, list.query) : []), [list.open, list.query, objectives]);
  const taken = useMemo(() => new Set(value.references.map((reference) => reference.id)), [value.references]);
  const full = value.references.length >= MAX_COMMODORE_REFERENCES;
  const index = Math.min(list.index, Math.max(0, candidates.length - 1));

  /** 토큰 아바타 자리 — DOM 을 다시 읽어 바뀐 경우에만 다시 그린다(실행 취소가 토큰 노드를 되살려도 그 자리에 아바타가 선다). */
  const slotsRef = useRef<readonly { readonly node: HTMLElement; readonly id: string }[]>([]);
  const scanTokens = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = Array.from(root.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}-mark`)).map((node) => ({ node, id: (node.parentElement as HTMLElement).dataset.refId ?? "" }));
    const current = slotsRef.current;
    if (current.length === next.length && current.every((slot, at) => slot.node === next[at]!.node)) return;
    // 처음 보는 자리에 이미 든 것은 브라우저가 복제한 지난 아바타다(실행 취소) — 비우고 새로 그린다. 아는 자리는 React 가 그리는 중이다.
    const known = new Set(current.map((slot) => slot.node));
    for (const slot of next) if (!known.has(slot.node)) slot.node.replaceChildren();
    slotsRef.current = next;
    setSlots(next);
  }, []);

  const refreshList = useCallback(() => {
    // 조합 중에도 질의는 자란다 — 조합 중인 글자로 목록을 좁힌다(Enter 는 조합이 끝난 뒤 고른다).
    const root = rootRef.current;
    const token = root && document.activeElement === root ? caretToken(root) : null;
    if (token && dismissed.current && (dismissed.current.node !== token.node || dismissed.current.at !== token.at)) dismissed.current = null;
    const open = !!token && !dismissed.current;
    setList((current) => {
      if (!open) return current.open ? CLOSED : current;
      if (current.open && current.query === token!.query) return current;
      return { open: true, query: token!.query, index: 0 };
    });
  }, []);

  const emit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = serialize(root);
    emitted.current = next;
    root.classList.toggle("is-empty", next.text.length === 0);
    scanTokens();
    if (!sameValue(next, latest.current.value)) latest.current.onChange(next);
  }, [scanTokens]);

  // 바깥 값이 우리가 낸 값과 다르면(보낸 뒤 비우기·초안 복원·Theater 바뀜) DOM 을 다시 세운다. 초점이 있으면 커서는 끝으로.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (emitted.current && sameValue(emitted.current, value)) return;
    build(root, t, value);
    emitted.current = value;
    root.classList.toggle("is-empty", value.text.length === 0);
    if (document.activeElement === root) placeCaretAtEnd(root);
    scanTokens();
    setList(CLOSED);
  }, [value, t, scanTokens]);

  // 커서가 화살표·클릭으로 옮겨 가면 '@' 자리를 다시 읽는다.
  useEffect(() => {
    const onSelection = () => { const root = rootRef.current; if (root && document.activeElement === root) refreshList(); };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [refreshList]);

  useEffect(() => { if (disabled) setList(CLOSED); }, [disabled]);

  const pick = useCallback((objective: Objective) => {
    const root = rootRef.current;
    if (!root) return;
    const current = serialize(root);
    if (current.references.some((reference) => reference.id === objective.id) || current.references.length >= MAX_COMMODORE_REFERENCES) return;
    const token = caretToken(root);
    if (!token) { setList(CLOSED); return; }
    const range = document.createRange();
    range.setStart(token.node, token.at);
    range.setEnd(token.node, token.end);
    range.deleteContents();
    // 토큰 뒤에 빈칸 하나 — 이어 쓰기 자리이고, 줄 끝 비편집 노드 뒤에서 커서가 사라지는 Chromium 버릇도 피한다.
    const space = document.createTextNode(" ");
    const node = tokenNode(latest.current.t, { id: objective.id, title: objective.title });
    range.insertNode(space);
    range.insertNode(node);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(after);
    root.normalize();
    dismissed.current = null;
    setList(CLOSED);
    emit();
  }, [emit]);

  const choose = useCallback((candidate: Candidate | undefined) => {
    if (!candidate) return;
    const { objective } = candidate;
    if (taken.has(objective.id) || full) return;
    pick(objective);
  }, [taken, full, pick]);

  const insertText = (text: string) => {
    const lines = stripMarks(text).replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, at) => {
      if (at > 0) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
  };

  useImperativeHandle(ref, () => ({
    focus: (options) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus(options);
      if (!caretInside(root)) placeCaretAtEnd(root);
    },
    openReferences: () => {
      const root = rootRef.current;
      if (!root || latest.current.disabled) return;
      root.focus({ preventScroll: true });
      const range = caretInside(root);
      if (!range) placeCaretAtEnd(root);
      // 앞 글자가 공백·문두가 아니면 빈칸을 하나 두고 '@' — 깨움 규칙이 문장 중간의 '@' 를 리터럴로 눕히기 때문이다.
      const caret = caretInside(root);
      let before = "";
      if (caret && caret.startContainer.nodeType === Node.TEXT_NODE) before = (caret.startContainer as Text).data.slice(0, caret.startOffset);
      else if (caret) { const prev = caret.startContainer.childNodes[caret.startOffset - 1]; before = prev ? (isToken(prev) ? CONVERSATION_REFERENCE_MARK : prev.nodeName === "BR" ? "\n" : prev.textContent ?? "") : ""; }
      dismissed.current = null;
      document.execCommand("insertText", false, before && !/\s$/.test(before) ? " @" : "@");
    },
  }), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const imeKey = event.nativeEvent.isComposing || event.keyCode === 229;
    if (list.open && candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (imeKey) return;
        const step = event.key === "ArrowDown" ? 1 : candidates.length - 1;
        setList((current) => ({ ...current, index: (index + step) % candidates.length }));
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const candidate = candidates[index];
        // 한글 조합 중 Enter 는 조합을 끝낸 뒤 고른다 — 조합이 이미 끝난 브라우저(Safari: compositionend 가 먼저)는 다음 틱에 고른다.
        if (imeKey) {
          if (composing.current) pendingPick.current = candidate?.objective ?? null;
          else if (candidate) setTimeout(() => choose(candidate), 0);
          return;
        }
        choose(candidate);
        return;
      }
    }
    if (list.open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const token = caretToken(root);
      dismissed.current = token ? { node: token.node, at: token.at } : null;
      setList(CLOSED);
      return;
    }
    if (!imeKey && (event.key === "Backspace" || event.key === "Delete") && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const token = tokenBesideCaret(root, event.key === "Delete");
      if (token) {
        event.preventDefault();
        const range = document.createRange();
        range.setStartBefore(token);
        range.collapse(true);
        token.remove();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        root.normalize();
        emit();
        return;
      }
    }
    latest.current.onKeyDown?.(event);
  };

  const onBeforeInput = (event: InputEvent) => {
    const type = event.inputType;
    // 문단 나눔은 줄바꿈 하나로(블록 div 를 만들지 않는다). 서식·HTML 끌어 놓기는 받지 않는다.
    if (type === "insertParagraph") { event.preventDefault(); document.execCommand("insertLineBreak"); return; }
    if (type.startsWith("format") || type === "insertFromDrop" || type === "insertFromPasteAsQuotation") event.preventDefault();
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("beforeinput", onBeforeInput);
    return () => root.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const { onFiles, isFile } = latest.current;
    const files = Array.from(event.clipboardData.files).filter((file) => (isFile ? isFile(file) : false));
    if (files.length) { onFiles?.(files); return; }
    const text = event.clipboardData.getData("text/plain");
    if (text) insertText(text);
  };

  const onCompositionEnd = (_event: CompositionEvent<HTMLDivElement>) => {
    composing.current = false;
    latest.current.onCompositionEnd?.();
    const objective = pendingPick.current;
    pendingPick.current = null;
    if (objective) setTimeout(() => pick(objective), 0);
  };

  const activeId = list.open && candidates[index] ? `${listId}-${candidates[index]!.objective.id}` : undefined;
  return (
    <>
      <div
        ref={rootRef}
        className={`${className} objectives-commodore-ref-input${value.text ? "" : " is-empty"}`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-placeholder={placeholder}
        aria-disabled={disabled || undefined}
        aria-describedby={ariaDescribedBy}
        aria-autocomplete="list"
        aria-controls={list.open ? listId : undefined}
        aria-activedescendant={activeId}
        data-placeholder={placeholder}
        spellCheck={false}
        tabIndex={disabled ? -1 : 0}
        onInput={() => { emit(); refreshList(); }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => latest.current.onKeyUp?.(event)}
        onPaste={onPaste}
        onDrop={(event) => {
          event.preventDefault();
          const { onFiles, isFile } = latest.current;
          const files = Array.from(event.dataTransfer.files).filter((file) => (isFile ? isFile(file) : false));
          if (files.length) onFiles?.(files);
        }}
        onCompositionStart={() => { composing.current = true; latest.current.onCompositionStart?.(); }}
        onCompositionEnd={onCompositionEnd}
        onFocus={refreshList}
        onBlur={() => { setList(CLOSED); latest.current.onBlur?.(); }}
      />
      {slots.map((slot, at) => createPortal(<ReferenceMark theaterId={theaterId} objectiveId={slot.id} size={14} />, slot.node, `${slot.id}:${at}`))}
      {list.open ? (
        <div id={listId} className={`objectives-commodore-ref-list${phone ? " is-phone" : ""}`} role="listbox" aria-label={t("objectives.commodore.reference.list")} onMouseDown={(event) => event.preventDefault()}>
          {full ? <p className="objectives-commodore-ref-note" role="status">{t("objectives.commodore.reference.limit", { count: MAX_COMMODORE_REFERENCES })}</p> : null}
          {candidates.map((candidate, at) => {
            const heading = at === 0 || (candidate.status === "done") !== (candidates[at - 1]!.status === "done");
            const isTaken = taken.has(candidate.objective.id);
            const unavailable = isTaken || full;
            const { objective } = candidate;
            const missions = objective.missions.length;
            const doneMissions = objective.missions.filter((mission) => mission.done).length;
            return [
              heading ? <p key={`h:${candidate.status === "done"}`} className="objectives-commodore-ref-heading" role="presentation">{t(candidate.status === "done" ? "objectives.commodore.reference.groupDone" : "objectives.commodore.reference.groupActive")}</p> : null,
              <div
                key={objective.id}
                id={`${listId}-${objective.id}`}
                role="option"
                aria-selected={at === index}
                aria-disabled={unavailable || undefined}
                className="objectives-commodore-ref-row"
                onMouseEnter={() => setList((current) => (current.index === at ? current : { ...current, index: at }))}
                onClick={() => choose(candidate)}
              >
                <ReferenceMark theaterId={theaterId} objectiveId={objective.id} size={phone ? 24 : 20} />
                <span className="objectives-commodore-ref-name">{objective.title}</span>
                <span className="objectives-commodore-ref-sub">
                  {isTaken ? <span>{`✓ ${t("objectives.commodore.reference.taken")}`}</span> : <>
                    <span className={candidate.status === "decision" ? "is-decision" : candidate.status === "review" ? "is-review" : undefined}>{t(`objectives.commodore.reference.status.${candidate.status}`)}</span>
                    {missions ? <span>{t("objectives.commodore.reference.missions", { done: doneMissions, total: missions })}</span> : null}
                  </>}
                </span>
              </div>,
            ];
          })}
          {candidates.length === 0 ? <p className="objectives-commodore-ref-empty">{list.query ? t("objectives.commodore.reference.empty", { query: list.query }) : t("objectives.commodore.reference.none")}</p> : null}
        </div>
      ) : null}
    </>
  );
});

/**
 * 지휘관(목표)의 몽글 얼굴 — 목록 행·입력 토큰·기록 토큰이 같이 쓴다. 보드에서 사라진 목표면 비운다(제목 글자만 남는다).
 * 활동은 지휘관 Operation 의 끌어올린 활동이고, 턴 뒤 백그라운드 작업은 진행 중으로 접는다(보드와 같은 셈).
 */
export function ReferenceMark({ theaterId, objectiveId, size }: { readonly theaterId: string; readonly objectiveId: string; readonly size: number }) {
  const { objectives } = useObjectiveTheater(theaterId);
  const operations = useOperationSummaries();
  const objective = objectives.find((candidate) => candidate.id === objectiveId);
  if (!objective) return null;
  const activity = operations.find((operation) => operation.id === objectiveId)?.activity ?? "closed";
  return <ObjectiveAvatar operationId={objectiveId} role="commander" state={commanderMongleState(objective, activity === "background" ? "running" : activity)} size={size} />;
}

/**
 * 기록 말풍선의 참조 토큰 — 표식은 지휘관 얼굴, 누르면 그 목표를 연다(데스크톱은 목표 패널의 그 목표, 폰은 폰 목표 착지).
 * 호스트 렌더러(`ctx.chat.Transcript`·`Conversation`)가 받는 모양이다.
 */
export function useCommodoreReferenceHost(t: T, theaterId: string, open: (objectiveId: string) => void): AgentChatReferenceHost {
  return useMemo(() => ({
    open,
    mark: (id: string) => <ReferenceMark theaterId={theaterId} objectiveId={id} size={14} />,
    describe: (reference: { readonly label: string }) => t("objectives.commodore.reference.open", { title: reference.label }),
  }), [t, theaterId, open]);
}
