/**
 * 원격 플릿 브라우저 입력 송신기 — 보기 전용 셸(원격 Desktop)의 스테이지가 실행 측 뷰포트로 보내는 입력 배치.
 *
 * 이 모듈은 Node API 를 쓰지 않는다. 크롬 문서 번들(tsup chrome, platform browser)에 그대로 들어가고,
 * Vitest 에서도 같은 파일로 검증한다. 전송 수단(fetch/REST)은 호출자가 주입한다.
 */

import {
  REMOTE_INPUT_MAX_EVENTS,
  type RemoteBrowserImeEvent,
  type RemoteBrowserInputBatch,
  type RemoteBrowserInputEvent,
  type RemoteBrowserKeyEvent,
  type RemoteBrowserMouseEvent,
} from "@fleet-console/protocol/desktop";

export interface ViewportBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CssSize {
  readonly width: number;
  readonly height: number;
}

export interface ContentAlign {
  readonly x: "left" | "center" | "right";
  readonly y: "top" | "center" | "bottom";
}

/**
 * `object-fit: contain` 으로 그려진 프레임의 실제 콘텐츠 영역(요소 기준 CSS px).
 * 스테이지(`object-position: top center`)처럼 가운데가 아니면 align 으로 맞춘다.
 */
export function contentRect(box: ViewportBox, css: CssSize, align: ContentAlign = { x: "center", y: "center" }): ViewportBox {
  if (!(box.width > 0 && box.height > 0 && css.width > 0 && css.height > 0)) {
    return { x: box.x, y: box.y, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / css.width, box.height / css.height);
  const width = css.width * scale;
  const height = css.height * scale;
  const x = align.x === "left" ? box.x : align.x === "right" ? box.x + box.width - width : box.x + (box.width - width) / 2;
  const y = align.y === "top" ? box.y : align.y === "bottom" ? box.y + box.height - height : box.y + (box.height - height) / 2;
  return { x, y, width, height };
}

/**
 * 스테이지 요소 위의 포인터를 실행 측 뷰포트 CSS px(0..cssWidth, 0..cssHeight)로 옮긴다.
 * 레터박스(여백)에 떨어지면 가장 가까운 콘텐츠 가장자리로 붙인다 — 실행 측에 좌표가
 * 콘텐츠 밖으로 나가면 Chromium 이 그 입력을 버리거나 엉뚱한 곳에 닿는다.
 */
export function toViewportPoint(
  clientX: number,
  clientY: number,
  box: ViewportBox,
  css: CssSize,
  align: ContentAlign = { x: "center", y: "center" },
): { x: number; y: number } {
  const content = contentRect(box, css, align);
  if (!(content.width > 0 && content.height > 0)) return { x: 0, y: 0 };
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  return {
    x: clamp(clientX - content.x, 0, content.width) / content.width * css.width,
    y: clamp(clientY - content.y, 0, content.height) / content.height * css.height,
  };
}

// ---------- Console 전역 단축키 충돌 회피 ----------

export interface ChordInput {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly code: string;
}

/**
 * 실행 측 `formatBeforeInputChord`(browser-views.ts)와 같은 문장으로 만든다 —
 * 같은 등록 목록에 같은 키가 걸리게. `platform` 은 스테이지 문서가 아는 실행 환경 값.
 */
export function formatRemoteChord(input: ChordInput, platform: string): string | null {
  // AltGr 는 Windows·Linux 에서만 Alt+Ctrl 동시 활성으로 나타난다. macOS 의 Ctrl+Alt 는 정상 단축키다.
  if (platform !== "darwin" && input.alt && input.ctrl) return null;
  if (!input.code) return null;
  const parts: string[] = [];
  if (platform === "darwin") {
    if (input.meta) parts.push("Mod");
    if (input.ctrl) parts.push("Ctrl");
  } else {
    if (input.ctrl) parts.push("Mod");
  }
  if (input.alt) parts.push("Alt");
  if (input.shift) parts.push("Shift");
  parts.push(input.code);
  return parts.join("+");
}

/** 등록된 Console 전역 단축키면 스테이지에서 실행 측으로 보내지 않는다 — 그 자리에서 Console 이 받는다. */
export function matchesConsoleShortcut(input: ChordInput, registered: ReadonlySet<string>, platform: string): boolean {
  if (registered.size === 0) return false;
  const chord = formatRemoteChord(input, platform);
  if (chord && registered.has(chord)) return true;
  // Non-mac 환경에서 "Ctrl+..." 명시적 등록 호환 (예: Ctrl+Space, Ctrl+Backquote) — 실행 측과 같은 규칙.
  if (platform !== "darwin" && input.ctrl && !input.alt) {
    const fallbackParts: string[] = ["Ctrl"];
    if (input.shift) fallbackParts.push("Shift");
    fallbackParts.push(input.code);
    if (registered.has(fallbackParts.join("+"))) return true;
  }
  return false;
}

// ---------- 키보드 이벤트 분류 ----------

export interface DomKeySnapshot {
  readonly key: string;
  readonly code: string;
  /** IME 조합 중이면 229, 브라우저마다 `isComposing` 이 먼저 선다. */
  readonly keyCode: number;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * IME 조합 키(`keyCode === 229` 또는 `isComposing`)는 키 경로가 아니라
 * composition/commit 경로로만 보낸다 — 양쪽으로 보내면 글자가 두 번 들어간다.
 */
export function isComposingKey(event: Pick<DomKeySnapshot, "keyCode" | "isComposing" | "key">): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === "Process";
}

export function toRemoteModifiers(event: Pick<DomKeySnapshot, "alt" | "ctrl" | "meta" | "shift">): {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
} {
  return { alt: event.alt, ctrl: event.ctrl, meta: event.meta, shift: event.shift };
}

export function toRemoteKeyEvent(event: DomKeySnapshot, type: "keyDown" | "keyUp"): RemoteBrowserKeyEvent {
  const keyEvent: RemoteBrowserKeyEvent = {
    kind: "key",
    type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    modifiers: toRemoteModifiers(event),
  };
  if (event.repeat) return { ...keyEvent, repeat: true };
  return keyEvent;
}

export function toRemoteMouseEvent(
  type: RemoteBrowserMouseEvent["type"],
  point: { x: number; y: number },
  event: Pick<DomKeySnapshot, "alt" | "ctrl" | "meta" | "shift"> & { button?: 0 | 1 | 2; clickCount?: number; deltaX?: number; deltaY?: number },
): RemoteBrowserMouseEvent {
  const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
  const mouse: RemoteBrowserMouseEvent = { kind: "mouse", type, x: point.x, y: point.y, modifiers: toRemoteModifiers(event) };
  if (type === "down" || type === "up") {
    return { ...mouse, button, ...(event.clickCount !== undefined ? { clickCount: event.clickCount } : {}) };
  }
  if (type === "wheel") {
    return { ...mouse, ...(event.deltaX !== undefined ? { deltaX: event.deltaX } : {}), ...(event.deltaY !== undefined ? { deltaY: event.deltaY } : {}) };
  }
  return mouse;
}

// ---------- 배치 송신기 ----------

export interface RemoteInputTransport {
  /** 한 배치를 실행 측으로 보낸다. 실패하면 rejected — 송신기가 seq 를 되감지는 않는다. */
  send(batch: RemoteBrowserInputBatch): Promise<void>;
}

export interface RemoteInputSenderOptions {
  readonly tabId: string;
  readonly spaceId?: string;
  readonly transport: RemoteInputTransport;
  /**
   * 첫 배치의 seq 를 이 값의 다음부터 센다. 스테이지 재적재 뒤 seq 가 0으로 돌아가
   * 실행 측의 순서 검사를 헷갈리지 않게, 호출자는 시각 기반의 시작점을 준다.
   */
  readonly startSeq?: number;
  readonly now?: () => number;
}

export interface RemoteInputSender {
  /** 지금 묶여 나가지 못한 이벤트 수(전송 중 + 대기). */
  readonly pendingCount: number;
  pushMouse(event: RemoteBrowserMouseEvent): void;
  pushKey(event: RemoteBrowserKeyEvent): void;
  pushIme(event: RemoteBrowserImeEvent): void;
  pushFocus(focused: boolean): void;
  /** 대기열을 지금 비운다 — 대개 직접 부를 일은 없고 discrete 이벤트가 스스로 비운다. */
  flush(): void;
}

const isCoalescibleMove = (event: RemoteBrowserInputEvent): event is RemoteBrowserMouseEvent =>
  event.kind === "mouse" && (event.type === "move" || event.type === "wheel");

/**
 * 원격 지연 대응 배치 송신기.
 *
 * - 전송 중(inflight)인 동안 들어온 연속 `move` 는 최신 1건으로, 연속 `wheel` 은
 *   델타 합산 1건으로 코얼레싱한다. 전송 중이 아니면 그대로 보낸다.
 * - `down`·`up`·`key`·`ime`·`focus` 는 순서를 엄격히 보존한다 — 코얼레싱 병합이
 *   discrete 이벤트를 가로지르지 않는다(병합은 대기열 맨 끝의 같은 종류하고만).
 * - `seq` 는 배치마다 1씩 오른다. 전송 실패는 그 배치를 버리고 다음 대기열부터
 *   이어간다 — 실패한 배치를 다시 보내면 down/up 짝이 어긋난다.
 */
export function createRemoteInputSender(options: RemoteInputSenderOptions): RemoteInputSender {
  const maxEvents = Math.max(1, REMOTE_INPUT_MAX_EVENTS);
  let seq = Number.isSafeInteger(options.startSeq) ? Math.max(0, options.startSeq as number) : 0;
  let outbox: RemoteBrowserInputEvent[] = [];
  let inflight: Promise<void> | null = null;

  const takeBatch = (): RemoteBrowserInputEvent[] => {
    const batch = outbox.slice(0, maxEvents);
    outbox = outbox.slice(batch.length);
    return batch;
  };

  const flush = (): void => {
    if (inflight !== null || outbox.length === 0) return;
    seq += 1;
    const batch: RemoteBrowserInputBatch = {
      tabId: options.tabId,
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      seq,
      events: takeBatch(),
    };
    let sending: Promise<void>;
    try {
      sending = options.transport.send(batch);
    } catch {
      inflight = null;
      return;
    }
    inflight = sending;
    void Promise.resolve(sending).then(
      () => {
        if (inflight === sending) inflight = null;
        flush();
      },
      () => {
        if (inflight === sending) inflight = null;
        flush();
      },
    );
  };

  const enqueue = (event: RemoteBrowserInputEvent): void => {
    const last = outbox[outbox.length - 1];
    if (inflight !== null && last && isCoalescibleMove(last) && isCoalescibleMove(event) && last.type === event.type) {
      if (event.type === "wheel") {
        const merged: RemoteBrowserMouseEvent = {
          ...event,
          deltaX: (last.deltaX ?? 0) + (event.deltaX ?? 0),
          deltaY: (last.deltaY ?? 0) + (event.deltaY ?? 0),
        };
        outbox[outbox.length - 1] = merged;
      } else {
        outbox[outbox.length - 1] = event;
      }
      return;
    }
    outbox.push(event);
    flush();
  };

  return {
    get pendingCount(): number {
      return outbox.length + (inflight !== null ? 1 : 0);
    },
    pushMouse: (event) => enqueue(event),
    pushKey: (event) => enqueue(event),
    pushIme: (event) => enqueue(event),
    pushFocus: (focused) => enqueue({ kind: "focus", focused }),
    flush,
  };
}
