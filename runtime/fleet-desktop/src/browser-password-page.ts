import {
  BROWSER_PASSWORD_SECRET_MAX_LENGTH,
  BROWSER_PASSWORD_USERNAME_MAX_LENGTH,
} from "@fleet-console/protocol/desktop/browser-passwords";
import type { BrowserPasswordOriginCredentials } from "./browser-password-vault.js";

/**
 * 로그인 폼 감지·자동완성·제출 포착. 페이지와 같은 DOM 을 보지만 실행은
 * `executeJavaScriptInIsolatedWorld` 격리 월드에서만 돈다 — 페이지 JS 가
 * 읽을 수 있는 전역·리스너·숨은 데이터는 남기지 않는다. 채운 값은 React·Vue
 * 제어 컴포넌트가 알아듣게 네이티브 setter 와 `input`·`change` 로 넣는다.
 *
 * 아래 `fleetPassword*` 함수 셋은 직렬화(`toString`)해 격리 월드로 보내므로
 * 모듈 범위를 참조하지 않는다 — 필요한 것은 인자로 받는다. 같은 이유로
 * 선택자 문자열은 각 함수 안에 직접 둔다(세 복사본은 함께 바꾼다).
 */

/** 격리 월드가 main 에 말을 거는 콘솔 접두. 페이지도 찍을 수 있으므로 값 자체는 main 이 검증한다. */
export const PASSWORD_CONSOLE_PREFIX = "[fleet-passwords]";
/** 페이지 격리 월드 id. 0(메인 월드)이 아닌 Desktop 전용 번호다. */
export const PASSWORD_PAGE_WORLD_ID = 7;

export interface FleetPasswordNode {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<FleetPasswordInput>;
}

export interface FleetPasswordInput extends FleetPasswordNode {
  readonly value: string;
  readonly disabled: boolean;
  readonly form: FleetPasswordNode | null;
  readonly offsetParent: unknown;
  getClientRects(): ArrayLike<unknown>;
  closest(selector: string): unknown;
  focus(): void;
  click(): void;
  dispatchEvent(event: unknown): boolean;
}

export interface FleetPasswordScope {
  querySelectorAll(selector: string): ArrayLike<FleetPasswordInput>;
}

export interface FleetPasswordDomEvent {
  readonly target: unknown;
  readonly type: string;
  readonly key?: string;
  preventDefault(): void;
}

export interface FleetPasswordDocument extends FleetPasswordScope {
  addEventListener(type: string, listener: (event: FleetPasswordDomEvent) => void, capture?: boolean): void;
}

export interface FleetPasswordFieldScan {
  readonly index: number;
  readonly action: string;
  readonly passwordName: string;
  readonly usernameName: string;
  readonly usernameVisible: boolean;
  readonly usernameValue: string;
  readonly usernameHasValue: boolean;
  readonly passwordHasValue: boolean;
  /** 제출 때만 싣는다. 평시 스캔은 유무만 본다. */
  readonly passwordValue?: string;
  readonly passwordCount: number;
  /** 신규·변경 폼(비밀번호가 둘이거나 `new-password`) — 제안·채움에서 뺀다. */
  readonly newPassword: boolean;
}

export interface FleetPasswordPageScan {
  readonly forms: readonly FleetPasswordFieldScan[];
}

export interface FleetPasswordFillTarget {
  readonly form: number;
  readonly usernameName: string;
  readonly username: string;
  readonly password: string;
  readonly focusPassword?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 보이는 로그인 폼을 훑는다. 값은 `withValues` 가 참일 때만 싣는다(제출 순간 판정용).
 * 격리 월드 직렬화를 위해 모듈 범위를 참조하지 않는다.
 */
export function fleetPasswordScan(scope: FleetPasswordScope, withValues?: boolean): FleetPasswordPageScan {
  const PASSWORD_SELECTOR = 'input[type="password"]';
  const USERNAME_SELECTOR = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"]';
  const forms: FleetPasswordFieldScan[] = [];
  let collected: FleetPasswordInput[] = [];
  try {
    const found = scope.querySelectorAll(PASSWORD_SELECTOR);
    for (let i = 0; i < found.length; i += 1) { const element = found[i]; if (element) collected.push(element); }
  } catch {
    return { forms };
  }
  const shown = (element: FleetPasswordInput): boolean => {
    try {
      if (element.disabled === true) return false;
      if ((element.getAttribute("type") ?? "").toLowerCase() === "hidden") return false;
      const rects = element.getClientRects();
      if (!rects || rects.length === 0) return false;
    } catch {
      return false;
    }
    return true;
  };
  const autoOf = (element: FleetPasswordInput): string => {
    try {
      return (element.getAttribute("autocomplete") ?? "").toLowerCase();
    } catch {
      return "";
    }
  };
  const typeOf = (element: FleetPasswordInput): string => {
    try {
      return (element.getAttribute("type") ?? "").toLowerCase();
    } catch {
      return "";
    }
  };
  const visible = collected.filter(shown);
  visible.forEach((password, index) => {
    const owner: FleetPasswordScope = password.form ?? scope;
    let candidates: FleetPasswordInput[] = [];
    try {
      const found = owner.querySelectorAll(USERNAME_SELECTOR);
      for (let i = 0; i < found.length; i += 1) { const element = found[i]; if (element && shown(element)) candidates.push(element); }
    } catch {
      candidates = [];
    }
    const scored = candidates.map((element) => {
      const auto = autoOf(element);
      const type = typeOf(element);
      const score = auto.indexOf("username") !== -1 ? 0
        : auto === "email" || auto.indexOf("email") !== -1 ? 1
        : type === "email" ? 2
        : type === "text" || type === "" ? 3
        : 4;
      return { element, score };
    }).sort((a, b) => a.score - b.score);
    const username = scored.length > 0 ? scored[0]!.element : null;
    const passwordAuto = autoOf(password);
    let passwordCount = 0;
    try {
      const found = owner.querySelectorAll(PASSWORD_SELECTOR);
      for (let i = 0; i < found.length; i += 1) { const element = found[i]; if (element && shown(element)) passwordCount += 1; }
    } catch {
      passwordCount = 1;
    }
    const usernameValue = username ? username.value ?? "" : "";
    const entry: FleetPasswordFieldScan = {
      index,
      action: password.form ? password.form.getAttribute("action") ?? "" : "",
      passwordName: password.getAttribute("name") ?? password.getAttribute("id") ?? "",
      usernameName: username ? username.getAttribute("name") ?? username.getAttribute("id") ?? "" : "",
      usernameVisible: username !== null,
      usernameValue,
      usernameHasValue: usernameValue.length > 0,
      passwordHasValue: (password.value ?? "").length > 0,
      passwordCount,
      newPassword: passwordAuto.indexOf("new-password") !== -1 || passwordCount > 1,
    };
    forms.push(withValues === true ? { ...entry, passwordValue: password.value ?? "" } : entry);
  });
  return { forms };
}

/**
 * 스캔에서 고른 한 폼을 채운다. 폼이 사라졌거나 사용자가 다른 값을 넣었으면 손대지 않고 거짓을 돌린다.
 * 격리 월드 직렬화를 위해 모듈 범위를 참조하지 않는다.
 */
export function fleetPasswordFill(doc: FleetPasswordDocument, target: FleetPasswordFillTarget): boolean {
  const PASSWORD_SELECTOR = 'input[type="password"]';
  const USERNAME_SELECTOR = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"]';
  const setNative = (element: FleetPasswordInput, value: string): void => {
    const record = element as unknown as Record<string, unknown>;
    const layers = [Object.getPrototypeOf(record), Object.getPrototypeOf(Object.getPrototypeOf(record))];
    for (const layer of layers) {
      if (!layer) continue;
      const descriptor = Object.getOwnPropertyDescriptor(layer, "value") as { set?: (this: unknown, value: string) => void } | undefined;
      const setter = descriptor?.set;
      if (typeof setter === "function") {
        setter.call(record, value);
        return;
      }
    }
    record.value = value;
  };
  const fire = (element: FleetPasswordInput, type: string): void => {
    const factory = (globalThis as unknown as { Event?: new (type: string, init?: Record<string, unknown>) => unknown }).Event;
    const event = typeof factory === "function" ? new factory(type, { bubbles: true, composed: true }) : { type, bubbles: true };
    try {
      element.dispatchEvent(event);
    } catch {
      /* 읽기 전용 문서 */
    }
  };
  const shown = (element: FleetPasswordInput): boolean => {
    try {
      if (element.disabled === true) return false;
      if ((element.getAttribute("type") ?? "").toLowerCase() === "hidden") return false;
      const rects = element.getClientRects();
      if (!rects || rects.length === 0) return false;
    } catch {
      return false;
    }
    return true;
  };
  let visible: FleetPasswordInput[] = [];
  try {
    const found = doc.querySelectorAll(PASSWORD_SELECTOR);
    for (let i = 0; i < found.length; i += 1) { const element = found[i]; if (element && shown(element)) visible.push(element); }
  } catch {
    return false;
  }
  const password = visible[target.form];
  if (!password) return false;
  const owner: FleetPasswordScope = password.form ?? doc;
  let username: FleetPasswordInput | null = null;
  let first: FleetPasswordInput | null = null;
  try {
    const found = owner.querySelectorAll(USERNAME_SELECTOR);
    for (let i = 0; i < found.length; i += 1) {
      const element = found[i];
      if (!element || !shown(element)) continue;
      if (!first) first = element;
      const key = element.getAttribute("name") ?? element.getAttribute("id") ?? "";
      if (target.usernameName !== "" && key === target.usernameName) username = element;
    }
  } catch {
    return false;
  }
  username = username ?? first;
  if (username) {
    const current = username.value ?? "";
    if (current !== "" && current !== target.username) return false;
    if (current === "") {
      setNative(username, target.username);
      fire(username, "input");
      fire(username, "change");
    }
  }
  setNative(password, target.password);
  fire(password, "input");
  fire(password, "change");
  if (target.focusPassword === true) {
    try {
      password.focus();
    } catch {
      /* 초점은 없어도 된다 */
    }
  }
  return true;
}

export interface FleetPasswordSessionHelpers {
  scan(scope: FleetPasswordScope, withValues?: boolean): FleetPasswordPageScan;
}

/**
 * 문서당 한 번만 깔리는 보고 리스너 — 제출 포착·입력칸 포커스·동적 DOM 을 main 에 알린다.
 * 제출 값은 이 순간에만 읽는다. 격리 월드 직렬화를 위해 판정(scan)은 인자로 받는다.
 */
export function fleetPasswordSession(
  doc: FleetPasswordDocument,
  post: (text: string) => void,
  helpers: FleetPasswordSessionHelpers,
  mutateDelayMs?: number,
): void {
  const flag = doc as unknown as Record<string, unknown>;
  if (flag.__fleetPasswordsInstalled === true) return;
  flag.__fleetPasswordsInstalled = true;
  const tell = (payload: Record<string, unknown>): void => {
    try {
      post(JSON.stringify(payload));
    } catch {
      /* 보고 통로가 막혔다 */
    }
  };
  const formOf = (node: unknown): FleetPasswordNode | null => {
    if (!node || typeof node !== "object") return null;
    try {
      const closest = (node as { closest?: unknown }).closest;
      if (typeof closest !== "function") return null;
      const form = (closest as (selector: string) => unknown).call(node, "form");
      if (!form || typeof form !== "object") return null;
      return form as FleetPasswordNode;
    } catch {
      return null;
    }
  };
  const readSubmit = (scope: FleetPasswordScope): { username: string; password: string } | null => {
    let snap: FleetPasswordPageScan;
    try {
      snap = helpers.scan(scope, true);
    } catch {
      return null;
    }
    const form = snap.forms.find((candidate) => !candidate.newPassword) ?? null;
    if (!form || !form.usernameVisible) return null;
    const username = form.usernameValue;
    const password = form.passwordValue ?? "";
    if (username.length === 0 || password.length === 0) return null;
    return { username, password };
  };
  doc.addEventListener("submit", (event) => {
    const scope = formOf((event as FleetPasswordDomEvent).target) ?? doc;
    const read = readSubmit(scope);
    if (!read) return;
    tell({ kind: "submitted", username: read.username, password: read.password });
  }, true);
  doc.addEventListener("click", (event) => {
    const target = (event as FleetPasswordDomEvent).target;
    const scope = formOf(target) ?? doc;
    const node = target as { tagName?: unknown; getAttribute?: (name: string) => string | null } | null;
    let nativeSubmit = false;
    if (node && typeof node === "object") {
      try {
        const type = typeof node.getAttribute === "function" ? (node.getAttribute("type") ?? "").toLowerCase() : "";
        // <button>의 기본 type은 submit이다 — 이런 단추는 뒤따르는 submit 이벤트가 보고한다.
        if (node.tagName === "INPUT") nativeSubmit = type === "submit" || type === "image";
        else if (node.tagName === "BUTTON") nativeSubmit = type === "submit" || type === "";
      } catch {
        nativeSubmit = false;
      }
    }
    // 폼 안 네이티브 제출 단추만 submit 이벤트에 맡기고, type="button"·role="button" React식 단추는 여기서 직접 읽는다.
    if (scope !== doc && nativeSubmit) return;
    const holder = target as { closest?: unknown } | null;
    const closest = holder && typeof holder === "object" ? holder.closest : null;
    if (typeof closest !== "function") return;
    let hit = false;
    try {
      hit = (closest as (selector: string) => unknown).call(target, "button, input[type=submit], input[type=button], input[type=image], [role=button]") != null;
    } catch {
      return;
    }
    if (!hit) return;
    const read = readSubmit(scope);
    if (!read) return;
    tell({ kind: "submitted", username: read.username, password: read.password });
  }, true);
  doc.addEventListener("keydown", (event) => {
    const typed = event as FleetPasswordDomEvent;
    if (typed.key !== "Enter") return;
    const target = typed.target as { tagName?: unknown } | null;
    if (!target || target.tagName !== "INPUT") return;
    if (formOf(target)) return;
    const read = readSubmit(doc);
    if (!read) return;
    tell({ kind: "submitted", username: read.username, password: read.password });
  }, true);
  doc.addEventListener("focusin", (event) => {
    const target = (event as FleetPasswordDomEvent).target as { tagName?: unknown; getAttribute?: (name: string) => string | null } | null;
    if (!target || target.tagName !== "INPUT" || typeof target.getAttribute !== "function") return;
    let type = "";
    let auto = "";
    try {
      type = (target.getAttribute("type") ?? "").toLowerCase();
      auto = (target.getAttribute("autocomplete") ?? "").toLowerCase();
    } catch {
      return;
    }
    if (type === "password" || auto.indexOf("username") !== -1 || auto.indexOf("current-password") !== -1 || auto === "email" || type === "email") {
      tell({ kind: "field-focused" });
    }
  }, true);
  const Observer = (globalThis as unknown as { MutationObserver?: new (callback: () => void) => { observe(node: unknown, init: unknown): void } }).MutationObserver;
  if (typeof Observer === "function") {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const delay = typeof mutateDelayMs === "number" && mutateDelayMs >= 0 ? mutateDelayMs : 400;
    try {
      new Observer(() => {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          tell({ kind: "forms-changed" });
        }, delay);
      }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "style"] });
    } catch {
      /* 정적 문서 */
    }
  }
}

/** 스캔에서 채울 폼 하나를 고른다 — 신규 폼은 제외, 아이디 후보가 있는 쪽이 먼저다. */
export function chooseLoginForm(forms: readonly FleetPasswordFieldScan[]): FleetPasswordFieldScan | null {
  const usable = forms.filter((form) => !form.newPassword);
  if (usable.length === 0) return null;
  const withUser = usable.filter((form) => form.usernameVisible);
  const pool = withUser.length > 0 ? withUser : usable;
  const rank = (form: FleetPasswordFieldScan): number => (form.passwordCount === 1 ? 0 : 1);
  return pool.slice().sort((a, b) => rank(a) - rank(b) || a.index - b.index)[0] ?? null;
}

export interface StoredLoginCredential {
  readonly id: string;
  readonly username: string;
  readonly updatedAt: number;
}

/**
 * 자동완성 규칙 — 에이전트 탭은 가장 최근 계정을 즉시, 사용자 탭은 하나면 즉시,
 * 둘이면 고르게 한다("pick"). 없으면 null.
 */
export function chooseAutofillCredential(
  credentials: readonly StoredLoginCredential[],
  isAgentTab: boolean,
): StoredLoginCredential | "pick" | null {
  if (credentials.length === 0) return null;
  const latest = credentials.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
  if (isAgentTab) return latest;
  if (credentials.length === 1) return latest;
  return "pick";
}

export type SavePromptDecision =
  | { readonly kind: "none" }
  | { readonly kind: "save" }
  | { readonly kind: "update"; readonly entryId: string };

/**
 * 저장 제안 판정 — 같은 (아이디, 비밀번호)는 조용히 넘기고, 같은 아이디의 다른
 * 비밀번호는 업데이트, 새 쌍은 저장. 제안 끔·저장 안 함 사이트는 묻지 않는다.
 */
export function decideSavePrompt(
  submitted: { readonly username: string; readonly password: string },
  stored: readonly { readonly id: string; readonly username: string; readonly password: string; readonly updatedAt: number }[],
  policy: { readonly offerToSave: boolean; readonly neverSaved: boolean },
): SavePromptDecision {
  if (!policy.offerToSave || policy.neverSaved) return { kind: "none" };
  if (submitted.username.length === 0 || submitted.password.length === 0) return { kind: "none" };
  const sameUser = stored.filter((entry) => entry.username === submitted.username);
  if (sameUser.some((entry) => entry.password === submitted.password)) return { kind: "none" };
  if (sameUser.length > 0) {
    const latest = sameUser.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    return { kind: "update", entryId: latest.id };
  }
  return { kind: "save" };
}

/** 한 페이지·폼 상태당 한 번만 채우게 묶는 키. */
export function loginFormKey(origin: string, form: FleetPasswordFieldScan): string {
  return `${origin}\n${form.index}\n${form.usernameName}\n${form.passwordName}`;
}

export interface PasswordPageHandle {
  url(): string | null;
  executeIsolated(code: string): Promise<unknown>;
}

export interface PasswordPageVault {
  forOrigin(origin: string): BrowserPasswordOriginCredentials;
  command(params: Record<string, unknown>): Promise<unknown>;
}

export interface PasswordSavePrompt {
  readonly kind: "save-prompt";
  readonly viewId: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly mode: "save" | "update";
  readonly entryId?: string;
}

export interface PasswordPickPrompt {
  readonly kind: "pick";
  readonly viewId: string;
  readonly origin: string;
  readonly usernames: readonly string[];
}

export type PasswordPrompt = PasswordSavePrompt | PasswordPickPrompt;

export interface BrowserPasswordPageAgentDeps {
  readonly vault: PasswordPageVault;
  readonly worldId?: number;
  readonly now?: () => number;
  readonly scanDebounceMs?: number;
  readonly onPrompt?: (prompt: PasswordPrompt | null) => void;
  readonly log?: (message: string) => void;
}

export interface BrowserPasswordPageHooks {
  attachView(viewId: string, handle: PasswordPageHandle): void;
  setVisible(viewId: string, visible: boolean, agent: boolean): void;
  pageReady(viewId: string): void;
  binding(viewId: string, payload: unknown): void;
  detachView(viewId: string): void;
}

interface PageTrack {
  handle: PasswordPageHandle;
  visible: boolean;
  isAgentTab: boolean;
  pageKey: string | null;
  filled: Set<string>;
  installedKey: string | null;
  scanning: boolean;
  queued: boolean;
  rescanTimer: ReturnType<typeof setTimeout> | null;
  lastSubmit: { username: string; password: string; at: number } | null;
}

function pageOriginOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateScan(value: unknown): FleetPasswordPageScan | null {
  if (!isRecord(value) || !Array.isArray(value.forms)) return null;
  const forms: FleetPasswordFieldScan[] = [];
  for (const raw of value.forms) {
    if (!isRecord(raw)) return null;
    if (typeof raw.index !== "number" || typeof raw.action !== "string" || typeof raw.passwordName !== "string"
      || typeof raw.usernameName !== "string" || typeof raw.usernameVisible !== "boolean" || typeof raw.usernameValue !== "string"
      || typeof raw.usernameHasValue !== "boolean" || typeof raw.passwordHasValue !== "boolean"
      || typeof raw.passwordCount !== "number" || typeof raw.newPassword !== "boolean") return null;
    if (raw.passwordValue !== undefined && typeof raw.passwordValue !== "string") return null;
    forms.push({
      index: raw.index,
      action: raw.action,
      passwordName: raw.passwordName,
      usernameName: raw.usernameName,
      usernameVisible: raw.usernameVisible,
      usernameValue: raw.usernameValue,
      usernameHasValue: raw.usernameHasValue,
      passwordHasValue: raw.passwordHasValue,
      ...(typeof raw.passwordValue === "string" ? { passwordValue: raw.passwordValue } : {}),
      passwordCount: raw.passwordCount,
      newPassword: raw.newPassword,
    });
  }
  return { forms };
}

interface BindingMessage {
  readonly kind: "submitted" | "field-focused" | "forms-changed";
  readonly username?: string;
  readonly password?: string;
}

function validateBinding(payload: unknown): BindingMessage | null {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 16_384) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.kind === "forms-changed" || parsed.kind === "field-focused") return { kind: parsed.kind };
  if (parsed.kind !== "submitted") return null;
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
  if (parsed.username.length === 0 || parsed.username.length > BROWSER_PASSWORD_USERNAME_MAX_LENGTH) return null;
  if (parsed.password.length === 0 || parsed.password.length > BROWSER_PASSWORD_SECRET_MAX_LENGTH) return null;
  return { kind: "submitted", username: parsed.username, password: parsed.password };
}

export function createBrowserPasswordPageAgent(deps: BrowserPasswordPageAgentDeps) {
  const worldId = deps.worldId ?? PASSWORD_PAGE_WORLD_ID;
  const now = deps.now ?? Date.now;
  const debounceMs = deps.scanDebounceMs ?? 150;
  const log = deps.log ?? (() => {});
  const tracks = new Map<string, PageTrack>();
  let prompt: PasswordPrompt | null = null;

  const SCAN_SOURCE = fleetPasswordScan.toString();
  const FILL_SOURCE = fleetPasswordFill.toString();
  const SESSION_SOURCE = fleetPasswordSession.toString();
  const sessionHelpers = `{ scan: ${SCAN_SOURCE} }`;

  const emit = (next: PasswordPrompt | null): void => {
    prompt = next;
    try {
      deps.onPrompt?.(next);
    } catch (error) {
      log(`password prompt failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };

  const clearPromptFor = (viewId: string): void => {
    if (prompt && prompt.viewId === viewId) emit(null);
  };

  const readCredentials = (origin: string): BrowserPasswordOriginCredentials | null => {
    try {
      return deps.vault.forOrigin(origin);
    } catch (error) {
      // fail-closed — 암호화 불가·손상時は 채움도 제안도 없다.
      log(`password origin refused: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  };

  const execute = async (track: PageTrack, code: string): Promise<unknown> => {
    try {
      return await track.handle.executeIsolated(code);
    } catch {
      return null;
    }
  };

  const fillNow = async (track: PageTrack, form: FleetPasswordFieldScan, credential: { username: string; password: string }, focusPassword: boolean): Promise<boolean> => {
    const target = JSON.stringify({ form: form.index, usernameName: form.usernameName, username: credential.username, password: credential.password, focusPassword });
    const result = await execute(track, `(${FILL_SOURCE})(document, ${target})`);
    return result === true;
  };

  const scanView = async (viewId: string): Promise<void> => {
    const track = tracks.get(viewId);
    if (!track) return;
    if (track.scanning) {
      track.queued = true;
      return;
    }
    track.scanning = true;
    try {
      for (;;) {
        track.queued = false;
        const origin = pageOriginOf(track.handle.url());
        if (!origin) return;
        const pageKey = `${origin}\n${track.handle.url() ?? ""}`;
        if (track.pageKey !== pageKey) {
          track.pageKey = pageKey;
          track.filled.clear();
          track.lastSubmit = null;
        }
        const raw = await execute(track, `(${SCAN_SOURCE})(document)`);
        const scan = validateScan(raw);
        if (!scan) return;
        const creds = readCredentials(origin);
        if (!creds) return;
        const form = chooseLoginForm(scan.forms);
        // 백그라운드 에이전트 탭도 채운다 — 표시 여부와 무관하게 에이전트 로그인 흐름이 멈추지 않게.
        // 사람 탭은 보이는 페이지에서만 건드린다.
        if (!form || (!track.visible && !track.isAgentTab)) return;
        const key = loginFormKey(origin, form);
        if (track.filled.has(key)) return;
        if (creds.credentials.length === 0) return;
        const pick = chooseAutofillCredential(creds.credentials, track.isAgentTab);
        if (pick === null || pick === "pick") return;
        const credential = creds.credentials.find((entry) => entry.id === pick.id) ?? null;
        if (!credential) return;
        // 사용자가 이미 고친 입력은 덮어쓰지 않는다 — 비어 있거나 같은 계정일 때만 채운다.
        if (form.passwordHasValue) {
          track.filled.add(key);
          return;
        }
        if (form.usernameHasValue && form.usernameValue !== credential.username) return;
        const filled = await fillNow(track, form, credential, false);
        if (filled) track.filled.add(key);
        return;
      }
    } finally {
      track.scanning = false;
      if (track.queued && tracks.has(viewId)) void scanView(viewId);
    }
  };

  const scanSoon = (viewId: string): void => {
    const track = tracks.get(viewId);
    if (!track) return;
    if (track.rescanTimer !== null) clearTimeout(track.rescanTimer);
    track.rescanTimer = setTimeout(() => {
      track.rescanTimer = null;
      void scanView(viewId);
    }, debounceMs);
  };

  const install = async (track: PageTrack): Promise<void> => {
    const pageKey = track.pageKey;
    if (track.installedKey !== null && track.installedKey === pageKey) return;
    const post = `(text) => { try { console.log(${JSON.stringify(PASSWORD_CONSOLE_PREFIX)} + text); } catch (e) { /* 보고 통로 없음 */ } }`;
    const code = `(${SESSION_SOURCE})(document, ${post}, ${sessionHelpers})`;
    await execute(track, code);
    track.installedKey = pageKey;
  };

  const handleSubmitted = async (viewId: string, username: string, password: string): Promise<void> => {
    const track = tracks.get(viewId);
    if (!track) return;
    const origin = pageOriginOf(track.handle.url());
    if (!origin) return;
    const at = now();
    if (track.lastSubmit && track.lastSubmit.username === username && track.lastSubmit.password === password && at - track.lastSubmit.at < 5_000) return;
    track.lastSubmit = { username, password, at };
    const creds = readCredentials(origin);
    if (!creds) return;
    const decision = decideSavePrompt({ username, password }, creds.credentials, { offerToSave: creds.offerToSave, neverSaved: creds.neverSaved });
    if (decision.kind === "none") return;
    emit({
      kind: "save-prompt",
      viewId,
      origin,
      username,
      password,
      mode: decision.kind,
      ...(decision.kind === "update" ? { entryId: decision.entryId } : {}),
    });
  };

  const handleFocused = async (viewId: string): Promise<void> => {
    const track = tracks.get(viewId);
    if (!track || !track.visible || track.isAgentTab) return;
    const origin = pageOriginOf(track.handle.url());
    if (!origin) return;
    const creds = readCredentials(origin);
    if (!creds || creds.credentials.length < 2) return;
    const raw = await execute(track, `(${SCAN_SOURCE})(document)`);
    const scan = validateScan(raw);
    if (!scan) return;
    const form = chooseLoginForm(scan.forms);
    if (!form) return;
    if (track.filled.has(loginFormKey(origin, form))) return;
    emit({ kind: "pick", viewId, origin, usernames: creds.credentials.map((entry) => entry.username) });
  };

  const hooks: BrowserPasswordPageHooks = {
    attachView(viewId, handle) {
      const existing = tracks.get(viewId);
      if (existing?.rescanTimer !== null && existing) clearTimeout(existing.rescanTimer);
      tracks.set(viewId, {
        handle,
        visible: existing?.visible ?? false,
        isAgentTab: existing?.isAgentTab ?? false,
        pageKey: null,
        filled: new Set(),
        installedKey: null,
        scanning: false,
        queued: false,
        rescanTimer: null,
        lastSubmit: null,
      });
    },
    setVisible(viewId, visible, agent) {
      const track = tracks.get(viewId);
      if (!track) return;
      track.visible = visible;
      track.isAgentTab = agent;
      if (!visible) {
        // 선택 목록은 표시 탭의 것이므로 거두지만, 저장 제안(특히 에이전트 탭의 제출)은
        // 탭 전환·비표시로 잃지 않고 유지한다. 뷰가 닫히면 detachView 가 거둔다.
        if (prompt?.kind === "pick" && prompt.viewId === viewId) emit(null);
        return;
      }
      void scanView(viewId);
    },
    pageReady(viewId) {
      const track = tracks.get(viewId);
      if (!track) return;
      const origin = pageOriginOf(track.handle.url());
      track.pageKey = origin ? `${origin}\n${track.handle.url() ?? ""}` : null;
      if (origin && track.installedKey !== track.pageKey) {
        track.filled.clear();
        track.lastSubmit = null;
      }
      void install(track).then(() => scanView(viewId), () => scanView(viewId));
    },
    binding(viewId, payload) {
      const message = validateBinding(payload);
      if (!message) return;
      if (message.kind === "forms-changed") {
        scanSoon(viewId);
        return;
      }
      if (message.kind === "field-focused") {
        void handleFocused(viewId);
        return;
      }
      void handleSubmitted(viewId, message.username ?? "", message.password ?? "");
    },
    detachView(viewId) {
      const track = tracks.get(viewId);
      if (track?.rescanTimer !== null && track) clearTimeout(track.rescanTimer);
      tracks.delete(viewId);
      clearPromptFor(viewId);
    },
  };

  const clearPrompt = (): boolean => {
    if (!prompt) return false;
    emit(null);
    return true;
  };

  return {
    ...hooks,
    /** 크롬 카드·선택 목록의 동작. 성공하면 카드를 거둔다. */
    async chromeAction(action: "password-pick" | "password-save" | "password-dismiss" | "password-never", username?: string): Promise<void> {
      if (action === "password-dismiss") {
        clearPrompt();
        return;
      }
      const current = prompt;
      if (!current) return;
      const track = tracks.get(current.viewId);
      try {
        if (action === "password-never" && current.kind === "save-prompt") {
          await deps.vault.command({ action: "add-never-save", origin: current.origin });
          clearPrompt();
          return;
        }
        if (action === "password-save" && current.kind === "save-prompt") {
          if (current.mode === "update" && current.entryId) {
            await deps.vault.command({ action: "update", id: current.entryId, username: current.username, password: current.password });
          } else {
            await deps.vault.command({ action: "save", origin: current.origin, username: current.username, password: current.password });
          }
          clearPrompt();
          return;
        }
        if (action === "password-pick" && current.kind === "pick" && typeof username === "string" && track) {
          const origin = pageOriginOf(track.handle.url());
          const creds = origin ? readCredentials(origin) : null;
          const credential = creds?.credentials.find((entry) => entry.username === username) ?? null;
          if (!credential) return;
          const raw = await execute(track, `(${SCAN_SOURCE})(document)`);
          const scan = validateScan(raw);
          const form = scan ? chooseLoginForm(scan.forms) : null;
          if (!form) return;
          const filled = await fillNow(track, form, credential, true);
          if (filled) {
            track.filled.add(loginFormKey(origin ?? current.origin, form));
            clearPrompt();
          }
          return;
        }
      } catch (error) {
        log(`password chrome action failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    },
    /** 카드·목록을 거두고 있었으면 참. */
    cancelPrompt(): boolean {
      return clearPrompt();
    },
    prompt(): PasswordPrompt | null {
      return prompt;
    },
  };
}

export type BrowserPasswordPageAgent = ReturnType<typeof createBrowserPasswordPageAgent>;
