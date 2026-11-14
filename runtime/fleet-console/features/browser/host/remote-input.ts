/**
 * 원격 스테이지 입력 중계 — `RemoteBrowserInputBatch` 를 CDP 로 옮긴다.
 *
 * 스테이지(원격 Desktop)가 보낸 배치는 routes 층에서 `isRemoteBrowserInputBatch` 로 한 번 걸러지고,
 * 여기서 한 이벤트씩 실행 측 뷰의 CDP 세션으로 번진다. 탭 조회·제어권 문(`browser_user_in_control`)·
 * 포인터 표시는 service 층이 쥐고 있으므로, 이 모듈은 그 판정을 `hooks` 로 받는다 — service 를 import 하지 않는다.
 *
 * `<select>` 는 실행 기기의 OS 네이티브 드롭다운으로 화면을 묶지 않게 가로챈다: 마우스가 닿기 전에
 * 페이지에서 `<select>` 를 찾아 팝업 스냅샷을 만들고 클릭 자체는 보내지 않는다. 답(선택 인덱스)이 오면
 * 페이지 안에서 `selected` 를 고치고 `input`·`change` 를 일으켜 로컬 클릭과 같은 일을 한다.
 */

import {
  isRemoteBrowserInputBatch,
  type RemoteBrowserImeEvent,
  type RemoteBrowserInputBatch,
  type RemoteBrowserKeyEvent,
  type RemoteBrowserMouseEvent,
  type RemoteBrowserPermissionPrompt,
  type RemoteBrowserSelectOption,
  type RemoteBrowserSelectPopup,
} from "@fleet-console/protocol/desktop";

import type { CdpClient } from "./cdp.js";
import { describeDomKey, isImeKeyEvent, modifierBits, toCdpKeyParams, type Modifiers } from "./keys.js";

/** 이 모듈이 던지는 실패 — service 층이 `BrowserPolicyError` 로 옮겨 싣는다. */
export class RemoteInputError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RemoteInputError";
    this.code = code;
    this.details = details;
  }
}

export interface RemotePointerState {
  readonly button: "left" | "right" | "middle";
  readonly buttons: number;
}

export interface RemoteInputHooks {
  /** 사람이 이 스페이스를 제어 중이면 던진다 — service 의 `guardInput` 을 그대로 건다. */
  assertControl(): void;
  /** 셸 커서·가드 알약에 남기는 포인터 자국 — service 의 `notePointer` 를 그대로 건다. */
  notePointer(kind: "move" | "click" | "type" | "scroll", at?: { x: number; y: number }): void;
  /** 클릭을 보내기 전 `<select>` 가로채기. 원격 팝업을 띄웠으면 그 팝업을 돌려준다. */
  interceptSelect?(x: number, y: number): Promise<RemoteBrowserSelectPopup | null>;
}

const BUTTONS = { left: 1, right: 2, middle: 4 } as const;

const toModifiers = (event: { modifiers?: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } }): Modifiers => ({
  alt: event.modifiers?.alt ?? false,
  ctrl: event.modifiers?.ctrl ?? false,
  meta: event.modifiers?.meta ?? false,
  shift: event.modifiers?.shift ?? false,
});

/** 마우스 한 건 — service.mouse 와 같은 좌표·버튼 규칙. 다음 포인터 상태를 돌려준다. */
export async function dispatchRemoteMouse(
  client: CdpClient,
  sessionId: string,
  event: RemoteBrowserMouseEvent,
  pointer: RemotePointerState | null,
): Promise<RemotePointerState | null> {
  const button = event.button ?? "left";
  const base = { x: Math.round(event.x), y: Math.round(event.y), modifiers: modifierBits(toModifiers(event)) };
  if (event.type === "wheel") {
    await client.send("Input.dispatchMouseEvent", { ...base, type: "mouseWheel", deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 }, sessionId);
    return pointer;
  }
  if (event.type === "move") {
    await client.send("Input.dispatchMouseEvent", {
      ...base,
      type: "mouseMoved",
      button: pointer?.button ?? "none",
      ...(pointer ? { buttons: pointer.buttons } : {}),
    }, sessionId);
    return pointer;
  }
  const clickCount = event.clickCount ?? 1;
  const buttons = BUTTONS[button];
  if (event.type === "down") {
    await client.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", button, buttons, clickCount }, sessionId);
    return { button, buttons };
  }
  await client.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", button, clickCount }, sessionId);
  return null;
}

/**
 * 키 한 건. IME 조합 키(229·isComposing)는 여기서 보내지 않고 `"ime-deferred"` 로 알린다 —
 * 스테이지가 composition/commit 으로 따로 보내므로 키 경로가 끼면 글자가 두 번 든다.
 */
export async function dispatchRemoteKey(
  client: CdpClient,
  sessionId: string,
  event: RemoteBrowserKeyEvent,
): Promise<"dispatched" | "ime-deferred"> {
  if (isImeKeyEvent({ keyCode: event.keyCode, key: event.key })) return "ime-deferred";
  const mods = toModifiers(event);
  const params = toCdpKeyParams(describeDomKey(event.key, event.code, mods), mods);
  await client.send("Input.dispatchKeyEvent", { ...params, type: params.text !== undefined ? "keyDown" : "rawKeyDown" }, sessionId);
  await client.send("Input.dispatchKeyEvent", {
    key: params.key,
    code: params.code,
    windowsVirtualKeyCode: params.windowsVirtualKeyCode,
    nativeVirtualKeyCode: params.nativeVirtualKeyCode,
    modifiers: params.modifiers,
    type: "keyUp",
  }, sessionId);
  return "dispatched";
}

/** IME 한 건 — `composition` 은 진행 중 조합, `commit` 은 확정, `cancel` 은 버림. */
export async function dispatchRemoteIme(client: CdpClient, sessionId: string, event: RemoteBrowserImeEvent): Promise<void> {
  const text = event.text ?? "";
  if (event.type === "commit") {
    if (text) await client.send("Input.insertText", { text }, sessionId);
    return;
  }
  if (event.type === "cancel") {
    await client.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }, sessionId);
    return;
  }
  await client.send(
    "Input.imeSetComposition",
    {
      text,
      selectionStart: event.selectionStart ?? text.length,
      selectionEnd: event.selectionEnd ?? text.length,
    },
    sessionId,
  );
}

export interface RemoteBatchResult {
  readonly dispatched: number;
  readonly imeDeferred: number;
  readonly select: RemoteBrowserSelectPopup | null;
}

/**
 * 배치 한 묶음을 순서대로 실행 측에 닿게 한다. 마우스 `down` 앞에서는 `<select>` 를 먼저 봐서
 * 네이티브 드롭다운이 실행 기기 화면을 묶기 전에 팝업으로 바꾼다.
 */
export async function applyRemoteInputBatch(
  client: CdpClient,
  sessionId: string,
  batch: unknown,
  pointer: RemotePointerState | null,
  hooks: RemoteInputHooks,
): Promise<{ pointer: RemotePointerState | null; result: RemoteBatchResult }> {
  if (!isRemoteBrowserInputBatch(batch)) throw new RemoteInputError("remote_input_invalid", "Remote input batch failed validation.");
  hooks.assertControl();
  let next = pointer;
  let dispatched = 0;
  let imeDeferred = 0;
  let select: RemoteBrowserSelectPopup | null = null;
  for (const event of batch.events) {
    hooks.assertControl();
    if (event.kind === "focus") {
      hooks.notePointer("move");
      dispatched += 1;
      continue;
    }
    if (event.kind === "ime") {
      await dispatchRemoteIme(client, sessionId, event);
      hooks.notePointer("type");
      dispatched += 1;
      continue;
    }
    if (event.kind === "key") {
      const outcome = await dispatchRemoteKey(client, sessionId, event);
      if (outcome === "ime-deferred") imeDeferred += 1;
      else dispatched += 1;
      hooks.notePointer("type");
      continue;
    }
    // mouse
    const at = { x: Math.round(event.x), y: Math.round(event.y) };
    if (event.type === "down" && hooks.interceptSelect) {
      const popup = await hooks.interceptSelect(event.x, event.y).catch(() => null);
      if (popup) {
        select = popup;
        hooks.notePointer("click", at);
        continue;
      }
    }
    next = await dispatchRemoteMouse(client, sessionId, event, next);
    hooks.notePointer(event.type === "wheel" ? "scroll" : event.type === "down" || event.type === "up" ? "click" : "move", at);
    dispatched += 1;
  }
  return { pointer: next, result: { dispatched, imeDeferred, select } };
}

// ---------- 원격 `<select>` ----------

const SELECT_EXTRACT_FUNCTION = `function() {
  const el = this;
  if (!(el instanceof HTMLSelectElement)) return null;
  const rect = el.getBoundingClientRect();
  const options = Array.from(el.options).map((option) => ({
    index: option.index,
    label: (option.label ?? option.text ?? "").slice(0, 1024),
    value: (option.value ?? "").slice(0, 1024),
    disabled: option.disabled === true,
    selected: option.selected === true,
    ...(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.label ? { group: String(option.parentElement.label).slice(0, 512) } : {}),
  }));
  return {
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    multiple: el.multiple === true,
    disabled: el.disabled === true,
    options,
  };
}`;

const SELECT_APPLY_FUNCTION = `function(indices, multiple) {
  const el = this;
  if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: "not_select" };
  const list = Array.isArray(indices) ? indices.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < el.options.length) : [];
  if (!multiple && list.length !== 1) return { ok: false, reason: "single_needs_one" };
  for (const option of el.options) option.selected = multiple ? list.includes(option.index) : option.index === list[0];
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: Array.from(el.selectedOptions).map((option) => option.index) };
}`;

export interface SelectProbeHit {
  readonly backendNodeId: number;
  readonly multiple: boolean;
  readonly disabled: boolean;
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly options: readonly RemoteBrowserSelectOption[];
}

/**
 * 그 좌표의 `<select>` 를 찾는다. `document.elementFromPoint` 로 페이지 안에서 찾으므로
 * `DOM.getNodeForLocation` 의 스크롤 어긋남을 피한다 — service 의 `inspectAt` 과 같은 자리 규칙이다.
 */
export async function probeSelectTarget(client: CdpClient, sessionId: string, x: number, y: number): Promise<SelectProbeHit | null> {
  const px = Math.round(x);
  const py = Math.round(y);
  const found = await client.send<{ result: { objectId?: string; subtype?: string } }>("Runtime.evaluate", {
    expression: `(function() { const hit = document.elementFromPoint(${px}, ${py}); const select = hit instanceof Element ? hit.closest("select") : null; return select; })()`,
  }, sessionId).catch(() => null);
  const objectId = found?.result.objectId;
  if (!objectId) return null;
  try {
    const node = await client.send<{ node: { backendNodeId: number } }>("DOM.requestNode", { objectId }, sessionId);
    const extracted = await client.send<{ result: { value?: { rect: SelectProbeHit["rect"]; multiple: boolean; disabled: boolean; options: SelectProbeHit["options"] } | null } }>(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: SELECT_EXTRACT_FUNCTION, returnByValue: true },
      sessionId,
    );
    const value = extracted.result.value;
    if (!value) return null;
    return { backendNodeId: node.node.backendNodeId, multiple: value.multiple, disabled: value.disabled, rect: value.rect, options: value.options };
  } finally {
    await client.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
  }
}

export interface RemoteSelectRegistryOptions {
  readonly now?: () => number;
  /** 답 없이 이 시간이 지나면 팝업이 만료된다 — 실행 측 클릭이 사라진 노드를 건드리지 않게. */
  readonly ttlMs?: number;
}

interface SelectEntry {
  readonly popup: RemoteBrowserSelectPopup;
  readonly sessionId: string;
  readonly backendNodeId: number;
  readonly at: number;
}

const DEFAULT_SELECT_TTL_MS = 5 * 60_000;

/** 팝업 id → 실행 측 노드의 대기表. 만료·소진을 스스로 지운다. */
export function createRemoteSelectRegistry(options: RemoteSelectRegistryOptions = {}): {
  open(tabId: string, sessionId: string, hit: SelectProbeHit): RemoteBrowserSelectPopup;
  take(popupId: string, tabId: string): SelectEntry | null;
  sweep(now?: number): number;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_SELECT_TTL_MS;
  let seq = 0;
  const entries = new Map<string, SelectEntry>();
  return {
    open(tabId, sessionId, hit) {
      seq += 1;
      const popup: RemoteBrowserSelectPopup = {
        id: `sel-${tabId}-${seq}`,
        tabId,
        rect: hit.rect,
        multiple: hit.multiple,
        options: hit.options,
      };
      entries.set(popup.id, { popup, sessionId, backendNodeId: hit.backendNodeId, at: now() });
      return popup;
    },
    take(popupId, tabId) {
      const entry = entries.get(popupId);
      if (!entry || entry.popup.tabId !== tabId) return null;
      entries.delete(popupId);
      if (now() - entry.at > ttlMs) return null;
      return entry;
    },
    sweep(current = now()) {
      let dropped = 0;
      for (const [id, entry] of entries) {
        if (current - entry.at > ttlMs) {
          entries.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}

export type RemoteSelectRegistry = ReturnType<typeof createRemoteSelectRegistry>;

/** 답을 페이지에 반영한다 — 한 번 답한 팝업은 소진된다. */
export async function applySelectChoice(
  client: CdpClient,
  registry: RemoteSelectRegistry,
  popupId: string,
  tabId: string,
  indices: readonly number[] | undefined,
  cancel: boolean,
): Promise<{ applied: boolean; reason?: string; selected?: readonly number[] }> {
  const entry = registry.take(popupId, tabId);
  if (!entry) return { applied: false, reason: "select_expired" };
  if (cancel) return { applied: true };
  const resolved = await client.send<{ objectId?: string }>("DOM.resolveNode", { backendNodeId: entry.backendNodeId }, entry.sessionId).catch(() => null);
  const objectId = resolved?.objectId;
  if (!objectId) return { applied: false, reason: "select_gone" };
  try {
    const applied = await client.send<{ result: { value?: { ok: boolean; reason?: string; selected?: number[] } } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: SELECT_APPLY_FUNCTION,
      arguments: [{ value: [...(indices ?? [])] }, { value: entry.popup.multiple }],
      returnByValue: true,
    }, entry.sessionId);
    const value = applied.result.value;
    if (!value?.ok) return { applied: false, reason: value?.reason ?? "select_rejected" };
    return { applied: true, selected: value.selected };
  } finally {
    await client.send("Runtime.releaseObject", { objectId }, entry.sessionId).catch(() => undefined);
  }
}

// ---------- 원격 권한 창 ----------

export interface RemotePermissionBridgeOptions {
  /** 답 없이 이 시간이 지나면 거부로 닫는다 — 페이지를 무한히 묶어 두지 않게. */
  readonly timeoutMs?: number;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

/**
 * 실행 측 WebContents 권한 요청과 원격 답을 잇는 대기 표.
 *
 * 실행 측(브라우저 세션)은 `request` 로 묶고 답을 기다리고, 원격 스테이지는
 * 스냅샷·스트림으로 프롬프트를 보고 `answer` 로 풀어 준다. 약속 없이 끝나면
 * 거부(`false`)로 닫는다 — 권한은 기본 거부가 안전하다.
 */
export function createRemotePermissionBridge(options: RemotePermissionBridgeOptions = {}): {
  request(prompt: RemoteBrowserPermissionPrompt): Promise<boolean>;
  answer(promptId: string, tabId: string, allow: boolean): boolean;
  pending(): RemoteBrowserPermissionPrompt[];
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const waiters = new Map<string, { prompt: RemoteBrowserPermissionPrompt; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  const key = (promptId: string, tabId: string): string => `${tabId}\u0000${promptId}`;
  return {
    request(prompt) {
      const id = key(prompt.id, prompt.tabId);
      const existing = waiters.get(id);
      if (existing) {
        clearTimeout(existing.timer);
        waiters.delete(id);
        existing.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (waiters.get(id)?.resolve === resolve) waiters.delete(id);
          resolve(false);
        }, timeoutMs);
        waiters.set(id, { prompt, resolve, timer });
      });
    },
    answer(promptId, tabId, allow) {
      const id = key(promptId, tabId);
      const waiter = waiters.get(id);
      if (!waiter) return false;
      waiters.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(allow);
      return true;
    },
    pending() {
      return [...waiters.values()].map((waiter) => waiter.prompt);
    },
  };
}

export type RemotePermissionBridge = ReturnType<typeof createRemotePermissionBridge>;
