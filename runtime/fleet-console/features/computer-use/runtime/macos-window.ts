import { execFile } from "node:child_process";
import { ComputerUseInputError, type ComputerUseWindowIdentity, type ComputerUseWindowState, type ComputerUseOpenResult } from "./platform.js";

// Read only: no AX writes, app activation, window raising, or process launch.
const INTERACTION_READINESS = `
ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function run(args) {
  var target=args[0], apps=$.NSWorkspace.sharedWorkspace.runningApplications, matches=[];
  for (var i=0;i<apps.count;i++) {
    var item=apps.objectAtIndex(i);
    if (ObjC.unwrap(item.bundleIdentifier)===target || ObjC.unwrap(item.bundleURL.path)===target.replace(/\\/$/,'') || ObjC.unwrap(item.localizedName)===target) matches.push(item);
  }
  if (!matches.length) return 'not_running';
  if (matches.length!==1) return 'ambiguous';
  var running=matches[0];
  if (running.hidden) return 'hidden';
  if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)!==Number(running.processIdentifier)) return 'not_frontmost';
  var app=$.AXUIElementCreateApplication(Number(running.processIdentifier)), focused=Ref();
  if ($.AXUIElementCopyAttributeValue(app,$('AXFocusedWindow'),focused)!==0) return 'window_unavailable';
  var minimized=Ref();
  if ($.AXUIElementCopyAttributeValue(ObjC.castRefToObject(focused[0]),$('AXMinimized'),minimized)!==0) return 'window_unavailable';
  return ObjC.unwrap(ObjC.castRefToObject(minimized[0])) ? 'minimized' : 'ready';
}`;

export type MacInteractionReadiness = "ready" | "not_running" | "ambiguous" | "hidden" | "not_frontmost" | "window_unavailable" | "minimized" | "unavailable";

export function readMacInteractionReadiness(app: string): Promise<MacInteractionReadiness> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", INTERACTION_READINESS, app], { timeout: 3000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      const state = stdout.trim();
      resolve(!error && ["ready", "not_running", "ambiguous", "hidden", "not_frontmost", "window_unavailable", "minimized"].includes(state) ? state as MacInteractionReadiness : "unavailable");
    });
  });
}

const WINDOW_STATE = `
ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function run(args) {
  var apps=$.NSWorkspace.sharedWorkspace.runningApplications;
  return JSON.stringify(args.map(function(target) {
    var state={app:target,status:'unknown',pid:null,frontmost:null,hidden:null,windowCount:null}, matches=[];
    for (var i=0;i<apps.count;i++) {
      var item=apps.objectAtIndex(i);
      if (ObjC.unwrap(item.bundleIdentifier)===target || ObjC.unwrap(item.bundleURL.path)===target || ObjC.unwrap(item.localizedName)===target) matches.push(item);
    }
    if (!matches.length) { state.status='not_running'; return state; }
    if (matches.length!==1) { state.reason='ambiguous_app'; return state; }
    var running=matches[0]; state.pid=Number(running.processIdentifier);
    state.frontmost=Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)===state.pid;
    state.hidden=Boolean(running.hidden);
    if (!$.AXIsProcessTrusted()) { state.reason='accessibility_permission_required'; return state; }
    var app=$.AXUIElementCreateApplication(state.pid), ref=Ref();
    $.AXUIElementSetMessagingTimeout(app,0.5);
    var error=$.AXUIElementCopyAttributeValue(app,$('AXWindows'),ref);
    if (error!==0) { state.reason='accessibility_error_'+error; return state; }
    var windows=ObjC.castRefToObject(ref[0]); state.windowCount=Number(windows.count);
    if (!state.windowCount) { state.status='no_window'; return state; }
    var unknown=false;
    for (var j=0;j<windows.count;j++) {
      var minimized=Ref();
      if ($.AXUIElementCopyAttributeValue(windows.objectAtIndex(j),$('AXMinimized'),minimized)!==0) { unknown=true; continue; }
      if (!ObjC.unwrap(ObjC.castRefToObject(minimized[0]))) { state.status='available'; return state; }
    }
    if (unknown) state.reason='window_attributes_unavailable'; else state.status='minimized';
    return state;
  }));
}`;

export function inspectMacWindows(apps: readonly string[], signal?: AbortSignal): Promise<ComputerUseWindowState[]> {
  if (!apps.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_STATE, ...apps], { timeout: 5000, maxBuffer: 128 * 1024, signal, windowsHide: true }, (error, stdout) => {
      if (!error) {
        try {
          const states = JSON.parse(stdout) as ComputerUseWindowState[];
          if (Array.isArray(states) && states.length === apps.length && states.every((state, i) => state.app === apps[i] && ["not_running", "no_window", "minimized", "available", "unknown"].includes(state.status))) return resolve(states);
        } catch { /* 조회 실패를 창 없음으로 바꾸지 않는다. */ }
      }
      resolve(apps.map((app) => ({ app, status: "unknown", pid: null, frontmost: null, hidden: null, windowCount: null, reason: signal?.aborted ? "cancelled" : "window_lookup_failed" })));
    });
  });
}

export async function openMacApp(app: string, signal: AbortSignal, activate: boolean): Promise<ComputerUseOpenResult> {
  if (signal.aborted) throw new Error("computer_use_stopped");
  // 정확한 설치 경로에 한 번만 재열기를 요청한다. 새 인스턴스나 대체 설치본은 실행하지 않는다.
  const request = await new Promise<{ requestDispatched: boolean; error?: string }>((resolve) => {
    let dispatched = false;
    const child = execFile("/usr/bin/open", [...(activate ? [] : ["-g"]), "-a", app], { timeout: 5000, maxBuffer: 4096, signal, windowsHide: true }, (error) => {
      resolve({ requestDispatched: dispatched, ...(error ? { error: signal.aborted ? "computer_use_stopped" : "computer_use_open_failed" } : {}) });
    });
    child.once("spawn", () => { dispatched = true; });
  });
  const deadline = Date.now() + 5000;
  let windowState: ComputerUseWindowState;
  do {
    windowState = (await inspectMacWindows([app], signal))[0]!;
    const windowReady = windowState.status === "available" && windowState.hidden === false && (!activate || windowState.frontmost === true);
    if (request.error || windowReady || signal.aborted || Date.now() >= deadline) return { ...request, windowReady, windowState };
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (!signal.aborted);
  return { ...request, windowReady: false, windowState, error: "computer_use_stopped" };
}

export async function assertMacInteractionReadiness(app: string, allowActivation: boolean): Promise<void> {
  if (allowActivation) {
    const [state] = await inspectMacWindows([app]);
    if (state?.hidden === true) throw new ComputerUseInputError("computer_use_app_hidden", "The app is hidden. Native AX reads can succeed while the Operation live preview is blank. No capture or input was sent. If showing the app is authorized, use computer_open on the same exact installation with activate:false, verify hidden:false, then request computer_state. Background reopen requests do not guarantee focus preservation. Do not replay an earlier input action.");
    if (state?.status === "no_window") throw new ComputerUseInputError("computer_use_no_action_window", "The app is running but AXWindows is empty. No capture or input was sent. Closing a window differs from minimizing it. Use computer_open with the exact app path only when opening the app is authorized, then request computer_state. Do not replay a previous action.");
    return;
  }
  const readiness = await readMacInteractionReadiness(app);
  if (readiness !== "ready") throw new ComputerUseInputError("computer_use_activation_blocked", `Native call not sent (${readiness}). Ask the user to show/focus the intended window, or use allowActivation:true only when the task authorizes foreground use. This is a best-effort preflight, not background execution support.`);
}

// 제목·창 순서 대신 해당 프로세스의 AX 선택 창을 CGWindowID로 연결한다.
// 비공개 AX 브리지가 없는 OS에서는 추측하지 않고 식별 불가로 반환한다.
const WINDOW_IDENTITY = `
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
ObjC.bindFunction('_AXUIElementGetWindow', ['int', ['void *', 'unsigned int *']]);
function run(args) {
  if (args[0]==='verify') {
    var pid=Number(args[1]), id=Number(args[2]), started=Number(args[3]);
    var process=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!process || process.hidden || Number(process.launchDate.timeIntervalSince1970)!==started) return 'false';
    var windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));
    return JSON.stringify(windows.some(w=>w.kCGWindowOwnerPID===pid&&w.kCGWindowNumber===id));
  }
  var target=args[0], apps=$.NSWorkspace.sharedWorkspace.runningApplications;
  var matches=[];
  for (var i=0;i<apps.count;i++) {
    var item=apps.objectAtIndex(i);
    if (ObjC.unwrap(item.bundleIdentifier)===target || ObjC.unwrap(item.bundleURL.path)===target.replace(/\\/$/,'') || ObjC.unwrap(item.localizedName)===target) matches.push(item);
  }
  if (matches.length!==1) return JSON.stringify({reason:matches.length?'app_ambiguous':'app_unmatched',matches:matches.length});
  var running=matches[0], pid=Number(running.processIdentifier);
  var app=$.AXUIElementCreateApplication(pid), focused=Ref();
  var axError=$.AXUIElementCopyAttributeValue(app,$('AXFocusedWindow'),focused);
  if (axError!==0) return JSON.stringify({reason:axError===-25211?'accessibility_permission_required':'ax_focused_window_error',axError:axError,pid:pid});
  var id=Ref();
  var idError=$._AXUIElementGetWindow(focused[0],id);
  if (idError!==0) return JSON.stringify({reason:'ax_window_id_unavailable',axError:idError,pid:pid});
  var rows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));
  var row=rows.find(w=>w.kCGWindowNumber===id[0]&&w.kCGWindowOwnerPID===pid);
  if (!row) return JSON.stringify({reason:'cg_window_missing',pid:pid,windowId:Number(id[0])});
  return JSON.stringify({pid:pid,windowId:id[0],processStartedAt:Number(running.launchDate.timeIntervalSince1970),title:row.kCGWindowName||''});
}`;

export function verifyMacWindowIdentity(target: ComputerUseWindowIdentity): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_IDENTITY, "verify", String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

/**
 * 창 식별 실패의 사유 코드. 진단 로그에만 실리고 판정은 바꾸지 않는다 — 식별자가 없으면 여전히 공유하지 않는다.
 * 경로·창 제목·앱 이름은 싣지 않고, 비민감 수치(pid·windowId·AX 오류 번호·일치 개수)만 남긴다.
 */
export interface MacWindowIdentityRead {
  readonly identity: ComputerUseWindowIdentity | null;
  readonly reason: "identified" | "app_unmatched" | "app_ambiguous" | "accessibility_permission_required" | "ax_focused_window_error" | "ax_window_id_unavailable" | "cg_window_missing" | "identity_invalid" | "identity_unparsable" | "window_lookup_failed";
  readonly detail?: { readonly matches?: number; readonly axError?: number; readonly pid?: number; readonly windowId?: number };
}

const IDENTITY_FAILURES = new Set(["app_unmatched", "app_ambiguous", "accessibility_permission_required", "ax_focused_window_error", "ax_window_id_unavailable", "cg_window_missing"]);
const finiteOrUndefined = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function readMacWindowIdentity(app: string): Promise<MacWindowIdentityRead> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_IDENTITY, app], { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      // 시간 초과·JXA 예외. 오류 문구에는 스크립트 원문이 실리므로 사유 코드만 남긴다.
      if (error) { resolve({ identity: null, reason: "window_lookup_failed" }); return; }
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { resolve({ identity: null, reason: "identity_unparsable" }); return; }
      const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
      if (record && typeof record.reason === "string" && IDENTITY_FAILURES.has(record.reason)) {
        const detail = { matches: finiteOrUndefined(record.matches), axError: finiteOrUndefined(record.axError), pid: finiteOrUndefined(record.pid), windowId: finiteOrUndefined(record.windowId) };
        resolve({ identity: null, reason: record.reason as MacWindowIdentityRead["reason"], detail: Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined)) });
        return;
      }
      const identity = record as ComputerUseWindowIdentity | null;
      resolve(identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.windowId) && identity.windowId > 0
        && Number.isFinite(identity.processStartedAt) && identity.processStartedAt > 0 && typeof identity.title === "string"
        ? { identity, reason: "identified" } : { identity: null, reason: "identity_invalid" });
    });
  });
}
