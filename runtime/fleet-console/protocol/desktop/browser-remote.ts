/**
 * 원격 플릿 브라우저 조작·저지연 스트림·팝업·비밀번호 프롬프트의 공유 계약.
 *
 * 이 파일은 Node·브라우저·셸 렌더러 어디서나 가져다 쓸 수 있도록 런타임 전용 API 를 두지 않는다.
 */

export const DESKTOP_BROWSER_REMOTE_CONTROL_CAPABILITY = "browser-remote-control";
export const DESKTOP_BROWSER_VIEWER_STREAM_PATH = "/api/v1/browser/viewer/stream";
export const DESKTOP_BROWSER_FRAME_CSS_WIDTH_HEADER = "x-fleet-frame-css-width";
export const DESKTOP_BROWSER_FRAME_CSS_HEIGHT_HEADER = "x-fleet-frame-css-height";

export const DESKTOP_BROWSER_ANSWER_PERMISSION = "Fleet.answerPermission";
export const DESKTOP_BROWSER_PASSWORD_ACTION = "Fleet.passwordAction";
export const DESKTOP_BROWSER_SELECT_POPUP = "Fleet.selectPopup";
export const DESKTOP_BROWSER_STAGE_FILES = "Fleet.stageRemoteFiles";
export const DESKTOP_BROWSER_CLEANUP_FILES = "Fleet.cleanupRemoteFiles";

export const REMOTE_FILE_CHOOSER_MAX_FILES = 10;
export const REMOTE_FILE_CHOOSER_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const REMOTE_FILE_CHOOSER_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const REMOTE_FRAME_STREAM_CONTENT_TYPE = "application/x-fleet-browser-stream";
export const REMOTE_FRAME_HEADER_BYTES = 32;
export const REMOTE_INPUT_MAX_EVENTS = 128;

const STREAM_MAGIC_0 = 0x46; // 'F'
const STREAM_MAGIC_1 = 0x42; // 'B'
const STREAM_MAGIC_2 = 0x46; // 'F'
const STREAM_MAGIC_3 = 0x31; // '1'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
const isShortText = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;

export interface RemoteInputModifiers {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface RemoteBrowserMouseEvent {
  readonly kind: "mouse";
  readonly type: "move" | "down" | "up" | "wheel";
  /** 대상 탭 뷰포트 기준 CSS px 좌표. */
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: RemoteInputModifiers;
}

export interface RemoteBrowserKeyEvent {
  readonly kind: "key";
  readonly type: "keyDown" | "keyUp";
  readonly key: string;
  readonly code: string;
  readonly keyCode?: number;
  readonly text?: string;
  readonly repeat?: boolean;
  readonly modifiers: RemoteInputModifiers;
}

export interface RemoteBrowserImeEvent {
  readonly kind: "ime";
  readonly type: "composition" | "commit" | "cancel";
  readonly text?: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

export interface RemoteBrowserFocusEvent {
  readonly kind: "focus";
  readonly focused: boolean;
}

export type RemoteBrowserInputEvent =
  | RemoteBrowserMouseEvent
  | RemoteBrowserKeyEvent
  | RemoteBrowserImeEvent
  | RemoteBrowserFocusEvent;

export interface RemoteBrowserInputBatch {
  readonly tabId: string;
  readonly spaceId?: string;
  readonly seq?: number;
  readonly events: readonly RemoteBrowserInputEvent[];
}

export interface RemoteBrowserSelectOption {
  readonly index: number;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly group?: string;
}

export interface RemoteBrowserSelectPopup {
  readonly id: string;
  readonly tabId: string;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly multiple: boolean;
  readonly options: readonly RemoteBrowserSelectOption[];
}

export interface RemoteBrowserSelectPopupAction {
  readonly popupId: string;
  readonly tabId: string;
  readonly action: "choose" | "cancel";
  readonly indices?: readonly number[];
}

export interface RemoteBrowserPermissionPrompt {
  readonly id: string;
  readonly tabId: string;
  readonly origin: string;
  readonly permission: string;
  readonly mediaTypes?: readonly ("video" | "audio")[];
}

export interface RemoteBrowserPermissionAction {
  readonly promptId: string;
  readonly tabId: string;
  readonly allow: boolean;
}

export type RemoteBrowserPasswordPrompt =
  | {
    readonly kind: "pick";
    readonly id: string;
    readonly tabId: string;
    readonly origin: string;
    readonly usernames: readonly string[];
    readonly origins?: readonly string[];
  }
  | {
    readonly kind: "save-prompt";
    readonly id: string;
    readonly tabId: string;
    readonly origin: string;
    readonly username: string;
    readonly mode: "save" | "update";
  };

export interface RemoteBrowserPasswordAction {
  readonly promptId: string;
  readonly tabId: string;
  readonly action: "pick" | "save" | "dismiss" | "never";
  readonly username?: string;
  readonly origin?: string;
}

export interface RemoteBrowserFileChooserPrompt {
  readonly id: string;
  readonly tabId: string;
  readonly multiple: boolean;
}

export interface RemoteBrowserUploadFile {
  readonly name: string;
  readonly contentBase64: string;
}

export interface RemoteBrowserFileChooserAction {
  readonly chooserId: string;
  readonly tabId: string;
  readonly action: "choose" | "cancel";
  readonly files?: readonly RemoteBrowserUploadFile[];
}

export interface RemoteBrowserStreamFrameMeta {
  readonly seq: number;
  readonly at: number;
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export interface RemoteBrowserDecodedFrame extends RemoteBrowserStreamFrameMeta {
  readonly jpeg: Uint8Array;
}

function isRemoteInputModifiers(value: unknown): value is RemoteInputModifiers {
  return isRecord(value)
    && typeof value.alt === "boolean"
    && typeof value.ctrl === "boolean"
    && typeof value.meta === "boolean"
    && typeof value.shift === "boolean";
}

export function isRemoteBrowserInputEvent(value: unknown): value is RemoteBrowserInputEvent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "mouse":
      return (value.type === "move" || value.type === "down" || value.type === "up" || value.type === "wheel")
        && isFiniteNumber(value.x) && isFiniteNumber(value.y)
        && value.x >= -16_384 && value.x <= 16_384 && value.y >= -16_384 && value.y <= 16_384
        && (value.button === undefined || value.button === "left" || value.button === "right" || value.button === "middle")
        && (value.clickCount === undefined || (Number.isSafeInteger(value.clickCount) && Number(value.clickCount) >= 0 && Number(value.clickCount) <= 10))
        && (value.deltaX === undefined || (isFiniteNumber(value.deltaX) && Math.abs(Number(value.deltaX)) <= 100_000))
        && (value.deltaY === undefined || (isFiniteNumber(value.deltaY) && Math.abs(Number(value.deltaY)) <= 100_000))
        && (value.modifiers === undefined || isRemoteInputModifiers(value.modifiers));
    case "key":
      return (value.type === "keyDown" || value.type === "keyUp")
        && isShortText(value.key, 64) && value.key.length > 0
        && isShortText(value.code, 64)
        && (value.keyCode === undefined || (Number.isSafeInteger(value.keyCode) && Number(value.keyCode) >= 0 && Number(value.keyCode) <= 65535))
        && (value.text === undefined || isShortText(value.text, 256))
        && (value.repeat === undefined || typeof value.repeat === "boolean")
        && isRemoteInputModifiers(value.modifiers);
    case "ime":
      return (value.type === "composition" || value.type === "commit" || value.type === "cancel")
        && (value.text === undefined || isShortText(value.text, 4096))
        && (value.selectionStart === undefined || (Number.isSafeInteger(value.selectionStart) && Number(value.selectionStart) >= 0))
        && (value.selectionEnd === undefined || (Number.isSafeInteger(value.selectionEnd) && Number(value.selectionEnd) >= 0));
    case "focus":
      return typeof value.focused === "boolean";
    default:
      return false;
  }
}

export function isRemoteBrowserInputBatch(value: unknown): value is RemoteBrowserInputBatch {
  return isRecord(value)
    && isSafeId(value.tabId)
    && (value.spaceId === undefined || isSafeId(value.spaceId))
    && (value.seq === undefined || (Number.isSafeInteger(value.seq) && Number(value.seq) >= 0))
    && Array.isArray(value.events) && value.events.length > 0 && value.events.length <= REMOTE_INPUT_MAX_EVENTS
    && value.events.every(isRemoteBrowserInputEvent);
}

export function isRemoteBrowserSelectPopup(value: unknown): value is RemoteBrowserSelectPopup {
  if (!isRecord(value) || !isSafeId(value.id) || !isSafeId(value.tabId) || typeof value.multiple !== "boolean") return false;
  if (!isRecord(value.rect) || !isFiniteNumber(value.rect.x) || !isFiniteNumber(value.rect.y) || !isFiniteNumber(value.rect.width) || !isFiniteNumber(value.rect.height)) return false;
  if (!Array.isArray(value.options) || value.options.length > 1000) return false;
  return value.options.every((option) => isRecord(option)
    && Number.isSafeInteger(option.index) && Number(option.index) >= 0
    && isShortText(option.label, 1024)
    && isShortText(option.value, 1024)
    && typeof option.disabled === "boolean"
    && typeof option.selected === "boolean"
    && (option.group === undefined || isShortText(option.group, 512)));
}

export function isRemoteBrowserSelectPopupAction(value: unknown): value is RemoteBrowserSelectPopupAction {
  return isRecord(value)
    && isSafeId(value.popupId)
    && isSafeId(value.tabId)
    && (value.action === "choose" || value.action === "cancel")
    && (value.indices === undefined || (Array.isArray(value.indices) && value.indices.length <= 1000 && value.indices.every((index) => Number.isSafeInteger(index) && Number(index) >= 0)));
}

export function isRemoteBrowserPermissionPrompt(value: unknown): value is RemoteBrowserPermissionPrompt {
  return isRecord(value)
    && isSafeId(value.id)
    && isSafeId(value.tabId)
    && isShortText(value.origin, 512)
    && isShortText(value.permission, 128) && value.permission.length > 0
    && (value.mediaTypes === undefined || (Array.isArray(value.mediaTypes) && value.mediaTypes.length <= 4 && value.mediaTypes.every((item) => item === "video" || item === "audio")));
}

export function isRemoteBrowserPermissionAction(value: unknown): value is RemoteBrowserPermissionAction {
  return isRecord(value) && isSafeId(value.promptId) && isSafeId(value.tabId) && typeof value.allow === "boolean";
}

export function isRemoteBrowserPasswordPrompt(value: unknown): value is RemoteBrowserPasswordPrompt {
  if (!isRecord(value) || !isSafeId(value.id) || !isSafeId(value.tabId) || !isShortText(value.origin, 512)) return false;
  if (value.kind === "pick") {
    if (!Array.isArray(value.usernames) || value.usernames.length === 0 || value.usernames.length > 100 || !value.usernames.every((name) => isShortText(name, 512))) return false;
    return value.origins === undefined || (Array.isArray(value.origins) && value.origins.length === value.usernames.length && value.origins.every((origin) => isShortText(origin, 512)));
  }
  if (value.kind === "save-prompt") {
    return isShortText(value.username, 512) && (value.mode === "save" || value.mode === "update");
  }
  return false;
}

export function isRemoteBrowserPasswordAction(value: unknown): value is RemoteBrowserPasswordAction {
  return isRecord(value)
    && isSafeId(value.promptId)
    && isSafeId(value.tabId)
    && (value.action === "pick" || value.action === "save" || value.action === "dismiss" || value.action === "never")
    && (value.username === undefined || isShortText(value.username, 512))
    && (value.origin === undefined || isShortText(value.origin, 512));
}

export function isRemoteBrowserFileChooserPrompt(value: unknown): value is RemoteBrowserFileChooserPrompt {
  return isRecord(value)
    && isSafeId(value.id)
    && isSafeId(value.tabId)
    && typeof value.multiple === "boolean";
}

export function isRemoteBrowserFileChooserAction(value: unknown): value is RemoteBrowserFileChooserAction {
  if (!isRecord(value) || !isSafeId(value.chooserId) || !isSafeId(value.tabId)) return false;
  if (value.action === "cancel") return value.files === undefined;
  if (value.action !== "choose") return false;
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > REMOTE_FILE_CHOOSER_MAX_FILES) return false;
  let totalBase64 = 0;
  const maxTotalBase64 = Math.ceil((REMOTE_FILE_CHOOSER_MAX_TOTAL_BYTES * 4) / 3) + 64;
  const maxSingleBase64 = Math.ceil((REMOTE_FILE_CHOOSER_MAX_FILE_BYTES * 4) / 3) + 16;
  return value.files.every((file) => {
    if (!isRecord(file) || !isShortText(file.name, 256) || file.name.length === 0 || typeof file.contentBase64 !== "string") return false;
    if (file.contentBase64.length > maxSingleBase64) return false;
    totalBase64 += file.contentBase64.length;
    return totalBase64 <= maxTotalBase64 && (file.contentBase64.length === 0 || /^[A-Za-z0-9+/]+={0,2}$/u.test(file.contentBase64));
  });
}

export function encodeRemoteBrowserFrame(meta: RemoteBrowserStreamFrameMeta, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(REMOTE_FRAME_HEADER_BYTES + jpeg.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, REMOTE_FRAME_HEADER_BYTES);
  out[0] = STREAM_MAGIC_0;
  out[1] = STREAM_MAGIC_1;
  out[2] = STREAM_MAGIC_2;
  out[3] = STREAM_MAGIC_3;
  view.setFloat64(4, meta.seq, false);
  view.setFloat64(12, meta.at, false);
  view.setUint16(20, Math.min(65535, Math.max(0, Math.round(meta.width))), false);
  view.setUint16(22, Math.min(65535, Math.max(0, Math.round(meta.height))), false);
  view.setUint16(24, Math.min(65535, Math.max(0, Math.round(meta.cssWidth))), false);
  view.setUint16(26, Math.min(65535, Math.max(0, Math.round(meta.cssHeight))), false);
  view.setUint32(28, jpeg.byteLength, false);
  out.set(jpeg, REMOTE_FRAME_HEADER_BYTES);
  return out;
}

export function createRemoteBrowserFrameDecoder(
  onFrame: (frame: RemoteBrowserDecodedFrame) => void,
  maxFrameBytes: number,
): (chunk: Uint8Array) => void {
  let pending: Uint8Array = new Uint8Array(0);
  let header: (RemoteBrowserStreamFrameMeta & { readonly byteLength: number }) | null = null;

  const append = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return;
    if (pending.byteLength === 0) {
      pending = chunk;
      return;
    }
    const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
    merged.set(pending, 0);
    merged.set(chunk, pending.byteLength);
    pending = merged;
  };

  return (chunk: Uint8Array): void => {
    append(chunk);
    for (;;) {
      if (header === null) {
        if (pending.byteLength < REMOTE_FRAME_HEADER_BYTES) return;
        if (pending[0] !== STREAM_MAGIC_0 || pending[1] !== STREAM_MAGIC_1 || pending[2] !== STREAM_MAGIC_2 || pending[3] !== STREAM_MAGIC_3) {
          throw new Error("remote_browser_stream_corrupt");
        }
        const view = new DataView(pending.buffer, pending.byteOffset, REMOTE_FRAME_HEADER_BYTES);
        const byteLength = view.getUint32(28, false);
        if (byteLength < 2 || byteLength > maxFrameBytes) throw new Error("remote_browser_stream_frame_size_invalid");
        header = {
          seq: view.getFloat64(4, false),
          at: view.getFloat64(12, false),
          width: view.getUint16(20, false),
          height: view.getUint16(22, false),
          cssWidth: view.getUint16(24, false),
          cssHeight: view.getUint16(26, false),
          byteLength,
        };
        pending = pending.subarray(REMOTE_FRAME_HEADER_BYTES);
      }
      if (pending.byteLength < header.byteLength) return;
      const jpeg = pending.slice(0, header.byteLength);
      pending = pending.subarray(header.byteLength);
      const current = header;
      header = null;
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("remote_browser_stream_invalid_jpeg");
      onFrame({
        seq: current.seq,
        at: current.at,
        width: current.width,
        height: current.height,
        cssWidth: current.cssWidth,
        cssHeight: current.cssHeight,
        jpeg,
      });
    }
  };
}
