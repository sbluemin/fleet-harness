import {
  DESKTOP_BROWSER_ANSWER_PERMISSION,
  DESKTOP_BROWSER_PASSWORD_ACTION,
  DESKTOP_BROWSER_SELECT_POPUP,
  isRemoteBrowserPasswordAction,
  isRemoteBrowserPermissionAction,
  isRemoteBrowserSelectPopupAction,
  type RemoteBrowserPasswordPrompt,
  type RemoteBrowserPermissionPrompt,
  type RemoteBrowserSelectPopup,
  type RemoteBrowserSelectPopupAction,
} from "@fleet-console/protocol/desktop";

import type { PasswordPrompt } from "./browser-password-page.js";

/**
 * 실행 측 Desktop 이 원격 시청자에게 넘기는 권한·비밀번호·select 훅.
 *
 * 평문 비밀번호는 여기 담지 않는다. 저장 제안은 origin·username·mode 만 릴레이하고,
 * 답은 `Fleet.passwordAction` 이 이 기계의 금고·채움기로만 돌아온다.
 * browser-views 는 `relayExtras` 를 다음 relay 에 실어 보내고, `onView` 로 뷰 id 를 묶어 준다.
 */

const PERMISSION_WAIT_MS = 120_000;

export interface RemoteShellPasswordAgent {
  chromeAction(action: "password-pick" | "password-save" | "password-dismiss" | "password-never", username?: string): Promise<void>;
}

export interface BrowserRemoteRelayExtras {
  readonly selectPopup: RemoteBrowserSelectPopup | null;
  readonly permissionPrompts: readonly RemoteBrowserPermissionPrompt[];
  readonly passwordPrompt: RemoteBrowserPasswordPrompt | null;
}

export interface BrowserRemoteShell {
  bindView(webContentsId: number, tabId: string): void;
  unbindView(webContentsId: number): void;
  requestPermission(input: {
    readonly webContentsId: number;
    readonly permission: string;
    readonly origin: string;
    readonly mediaTypes?: readonly ("video" | "audio")[];
    readonly callback: (allow: boolean) => void;
  }): void;
  notePassword(prompt: PasswordPrompt | null): void;
  noteSelect(popup: RemoteBrowserSelectPopup | null, answer?: (action: RemoteBrowserSelectPopupAction) => void): void;
  relayExtras(): BrowserRemoteRelayExtras;
  setFlush(flush: () => void): void;
  command(method: string, params: Record<string, unknown>, passwords: RemoteShellPasswordAgent): Promise<boolean>;
}

export function remotePasswordPrompt(prompt: PasswordPrompt | null): RemoteBrowserPasswordPrompt | null {
  if (!prompt) return null;
  const id = `password-${prompt.viewId}`;
  if (prompt.kind === "pick") {
    return { kind: "pick", id, tabId: prompt.viewId, origin: prompt.origin, usernames: [...prompt.usernames] };
  }
  return { kind: "save-prompt", id, tabId: prompt.viewId, origin: prompt.origin, username: prompt.username, mode: prompt.mode };
}

export function createBrowserRemoteShell(deps: { readonly setTimeout?: typeof setTimeout; readonly clearTimeout?: typeof clearTimeout } = {}): BrowserRemoteShell {
  const schedule = deps.setTimeout ?? setTimeout;
  const cancel = deps.clearTimeout ?? clearTimeout;
  const tabs = new Map<number, string>();
  const permissions = new Map<string, { readonly prompt: RemoteBrowserPermissionPrompt; readonly callback: (allow: boolean) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  let password: RemoteBrowserPasswordPrompt | null = null;
  let selectPopup: RemoteBrowserSelectPopup | null = null;
  let selectAnswer: ((action: RemoteBrowserSelectPopupAction) => void) | null = null;
  let flush: (() => void) | null = null;
  let serial = 0;

  const publish = (): void => { flush?.(); };

  const finishPermission = (id: string, allow: boolean): void => {
    const pending = permissions.get(id);
    if (!pending) return;
    permissions.delete(id);
    cancel(pending.timer);
    try { pending.callback(allow); } catch { /* 페이지가 이미 닫혔다 */ }
    publish();
  };

  return {
    bindView(webContentsId, tabId) { tabs.set(webContentsId, tabId); },
    unbindView(webContentsId) {
      const tabId = tabs.get(webContentsId);
      tabs.delete(webContentsId);
      if (!tabId) return;
      for (const [id, pending] of permissions) if (pending.prompt.tabId === tabId) finishPermission(id, false);
      if (selectPopup?.tabId === tabId) { selectPopup = null; selectAnswer = null; publish(); }
      if (password?.tabId === tabId) { password = null; publish(); }
    },
    requestPermission(input) {
      const tabId = tabs.get(input.webContentsId);
      if (!tabId || input.permission.length === 0 || input.permission.length > 128) { input.callback(false); return; }
      serial += 1;
      const id = `perm-${serial}`;
      const prompt: RemoteBrowserPermissionPrompt = {
        id,
        tabId,
        origin: input.origin.slice(0, 512),
        permission: input.permission,
        ...(input.mediaTypes && input.mediaTypes.length > 0 ? { mediaTypes: input.mediaTypes.slice(0, 4) } : {}),
      };
      const timer = schedule(() => finishPermission(id, false), PERMISSION_WAIT_MS);
      permissions.set(id, { prompt, callback: input.callback, timer });
      publish();
    },
    notePassword(prompt) {
      password = remotePasswordPrompt(prompt);
      publish();
    },
    noteSelect(popup, answer) {
      selectPopup = popup;
      selectAnswer = popup && answer ? answer : null;
      publish();
    },
    relayExtras: () => ({ selectPopup, permissionPrompts: [...permissions.values()].map((entry) => entry.prompt), passwordPrompt: password }),
    setFlush(next) { flush = next; next(); },
    async command(method, params, passwords) {
      if (method === DESKTOP_BROWSER_ANSWER_PERMISSION) {
        if (!isRemoteBrowserPermissionAction(params)) throw new Error("permission_action_invalid");
        if (!permissions.has(params.promptId)) throw new Error("permission_prompt_missing");
        finishPermission(params.promptId, params.allow);
        return true;
      }
      if (method === DESKTOP_BROWSER_PASSWORD_ACTION) {
        if (!isRemoteBrowserPasswordAction(params)) throw new Error("password_action_invalid");
        if (!password || password.id !== params.promptId || password.tabId !== params.tabId) throw new Error("password_prompt_missing");
        const action = params.action === "pick" ? "password-pick" : params.action === "save" ? "password-save" : params.action === "dismiss" ? "password-dismiss" : "password-never";
        await passwords.chromeAction(action, params.username);
        return true;
      }
      if (method === DESKTOP_BROWSER_SELECT_POPUP) {
        if (!isRemoteBrowserSelectPopupAction(params)) throw new Error("select_popup_invalid");
        if (!selectPopup || selectPopup.id !== params.popupId || selectPopup.tabId !== params.tabId || !selectAnswer) throw new Error("select_popup_missing");
        const answer = selectAnswer;
        selectPopup = null;
        selectAnswer = null;
        publish();
        answer(params);
        return true;
      }
      return false;
    },
  };
}
