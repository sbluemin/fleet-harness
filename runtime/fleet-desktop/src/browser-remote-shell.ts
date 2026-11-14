import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_BROWSER_ANSWER_PERMISSION,
  DESKTOP_BROWSER_CLEANUP_FILES,
  DESKTOP_BROWSER_PASSWORD_ACTION,
  DESKTOP_BROWSER_SELECT_POPUP,
  DESKTOP_BROWSER_STAGE_FILES,
  REMOTE_FILE_CHOOSER_MAX_FILE_BYTES,
  REMOTE_FILE_CHOOSER_MAX_FILES,
  REMOTE_FILE_CHOOSER_MAX_TOTAL_BYTES,
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
/** 안전장치 — Console 이 정리 신호를 보내기 전에 끊겨도 임시 업로드 파일이 남지 않게 한다. */
const DEFAULT_STAGING_TTL_MS = 30 * 60_000;

export interface RemoteShellPasswordAgent {
  chromeAction(action: "password-pick" | "password-save" | "password-dismiss" | "password-never", username?: string, origin?: string): Promise<void>;
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
  command(method: string, params: Record<string, unknown>, passwords: RemoteShellPasswordAgent): Promise<{ readonly handled: boolean; readonly result?: unknown }>;
  cleanupAll(): void;
}

function sanitizeUploadFilename(raw: string, index: number, used: Set<string>): string {
  const base = path.basename(raw.replace(/[\\/]/g, "/")).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  const clean = !base || base === "." || base === ".." ? `file-${index + 1}` : base.slice(0, 180);
  if (!used.has(clean)) { used.add(clean); return clean; }
  const ext = path.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${stem}-${suffix}${ext}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

export function remotePasswordPrompt(prompt: PasswordPrompt | null): RemoteBrowserPasswordPrompt | null {
  if (!prompt) return null;
  const id = `password-${prompt.viewId}`;
  if (prompt.kind === "pick") {
    return { kind: "pick", id, tabId: prompt.viewId, origin: prompt.origin, usernames: [...prompt.usernames], origins: [...prompt.origins] };
  }
  return { kind: "save-prompt", id, tabId: prompt.viewId, origin: prompt.origin, username: prompt.username, mode: prompt.mode };
}

export function createBrowserRemoteShell(deps: { readonly setTimeout?: typeof setTimeout; readonly clearTimeout?: typeof clearTimeout; readonly stagingTtlMs?: number } = {}): BrowserRemoteShell {
  const schedule = deps.setTimeout ?? setTimeout;
  const cancel = deps.clearTimeout ?? clearTimeout;
  const stagingTtlMs = deps.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS;
  const tabs = new Map<number, string>();
  const permissions = new Map<string, { readonly prompt: RemoteBrowserPermissionPrompt; readonly callback: (allow: boolean) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  let password: RemoteBrowserPasswordPrompt | null = null;
  let selectPopup: RemoteBrowserSelectPopup | null = null;
  let selectAnswer: ((action: RemoteBrowserSelectPopupAction) => void) | null = null;
  const stagedDirs = new Map<string, { readonly dir: string; readonly viewId: string | null; readonly timer: ReturnType<typeof setTimeout> }>();
  let flush: (() => void) | null = null;
  let serial = 0;

  const removeStagedDir = (stagingId: string): void => {
    const entry = stagedDirs.get(stagingId);
    if (!entry) return;
    stagedDirs.delete(stagingId);
    cancel(entry.timer);
    try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch { /* 이미 정리됨 */ }
  };

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
      for (const [stagingId, entry] of [...stagedDirs]) if (entry.viewId === tabId) removeStagedDir(stagingId);
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
    cleanupAll() { for (const stagingId of [...stagedDirs.keys()]) removeStagedDir(stagingId); },
    async command(method, params, passwords) {
      if (method === DESKTOP_BROWSER_STAGE_FILES) {
        const rawFiles = Array.isArray(params.files) ? params.files : null;
        if (!rawFiles || rawFiles.length === 0 || rawFiles.length > REMOTE_FILE_CHOOSER_MAX_FILES) throw new Error("stage_files_invalid");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-remote-upload-"));
        try { fs.chmodSync(dir, 0o700); } catch { /* 플랫폼 허용 범위 */ }
        const stagingId = `stage-${++serial}`;
        const viewId = typeof params.viewId === "string" && params.viewId.length > 0 ? params.viewId : null;
        const timer = schedule(() => removeStagedDir(stagingId), stagingTtlMs);
        (timer as { unref?: () => void }).unref?.();
        stagedDirs.set(stagingId, { dir, viewId, timer });
        const used = new Set<string>();
        const paths: string[] = [];
        let total = 0;
        try {
          for (let index = 0; index < rawFiles.length; index += 1) {
            const entry = rawFiles[index] as { name?: unknown; contentBase64?: unknown } | null;
            if (!entry || typeof entry.name !== "string" || typeof entry.contentBase64 !== "string") throw new Error("stage_files_invalid");
            const data = Buffer.from(entry.contentBase64, "base64");
            if (data.byteLength > REMOTE_FILE_CHOOSER_MAX_FILE_BYTES) throw new Error("stage_file_too_large");
            total += data.byteLength;
            if (total > REMOTE_FILE_CHOOSER_MAX_TOTAL_BYTES) throw new Error("stage_files_too_large");
            const fileName = sanitizeUploadFilename(entry.name, index, used);
            const target = path.join(dir, fileName);
            fs.writeFileSync(target, data, { mode: 0o600 });
            paths.push(target);
          }
          return { handled: true, result: { stagingId, paths } };
        } catch (error) {
          removeStagedDir(stagingId);
          throw error;
        }
      }
      if (method === DESKTOP_BROWSER_CLEANUP_FILES) {
        if (typeof params.stagingId === "string") removeStagedDir(params.stagingId);
        return { handled: true, result: { cleaned: true } };
      }
      if (method === DESKTOP_BROWSER_ANSWER_PERMISSION) {
        if (!isRemoteBrowserPermissionAction(params)) throw new Error("permission_action_invalid");
        if (!permissions.has(params.promptId)) throw new Error("permission_prompt_missing");
        finishPermission(params.promptId, params.allow);
        return { handled: true };
      }
      if (method === DESKTOP_BROWSER_PASSWORD_ACTION) {
        if (!isRemoteBrowserPasswordAction(params)) throw new Error("password_action_invalid");
        if (!password || password.id !== params.promptId || password.tabId !== params.tabId) throw new Error("password_prompt_missing");
        const action = params.action === "pick" ? "password-pick" : params.action === "save" ? "password-save" : params.action === "dismiss" ? "password-dismiss" : "password-never";
        await passwords.chromeAction(action, params.username, params.origin);
        return { handled: true };
      }
      if (method === DESKTOP_BROWSER_SELECT_POPUP) {
        if (!isRemoteBrowserSelectPopupAction(params)) throw new Error("select_popup_invalid");
        if (!selectPopup || selectPopup.id !== params.popupId || selectPopup.tabId !== params.tabId || !selectAnswer) throw new Error("select_popup_missing");
        const answer = selectAnswer;
        selectPopup = null;
        selectAnswer = null;
        publish();
        answer(params);
        return { handled: true };
      }
      return { handled: false };
    },
  };
}
