import { execFile } from "node:child_process";
import { ComputerUseInputError, type ComputerUseWindowIdentity, type ComputerUseWindowState, type ComputerUseOpenResult } from "./computer-use-platform.js";

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
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", INTERACTION_READINESS, app], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
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
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_STATE, ...apps], { timeout: 5000, maxBuffer: 128 * 1024, signal }, (error, stdout) => {
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
    const child = execFile("/usr/bin/open", [...(activate ? [] : ["-g"]), "-a", app], { timeout: 5000, maxBuffer: 4096, signal }, (error) => {
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
  if (matches.length!==1) return 'null';
  var running=matches[0], pid=Number(running.processIdentifier);
  var app=$.AXUIElementCreateApplication(pid), focused=Ref();
  var axError=$.AXUIElementCopyAttributeValue(app,$('AXFocusedWindow'),focused);
  if (axError!==0) throw Error('window_accessibility_'+axError);
  var id=Ref();
  if ($._AXUIElementGetWindow(focused[0],id)!==0) return 'null';
  var rows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));
  var row=rows.find(w=>w.kCGWindowNumber===id[0]&&w.kCGWindowOwnerPID===pid);
  if (!row) return 'null';
  return JSON.stringify({pid:pid,windowId:id[0],processStartedAt:Number(running.launchDate.timeIntervalSince1970),title:row.kCGWindowName||''});
}`;

export function verifyMacWindowIdentity(target: ComputerUseWindowIdentity): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_IDENTITY, "verify", String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

export function readMacWindowIdentity(app: string): Promise<ComputerUseWindowIdentity | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_IDENTITY, app], { timeout: 3000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { process.stderr.write(`[fleet-computer-use] window identity unavailable: ${/window_accessibility_-25211/.test(error.message) ? "accessibility_permission_required" : "window_lookup_failed"}\n`); resolve(null); return; }
      try {
        const value = JSON.parse(stdout) as ComputerUseWindowIdentity | null;
        resolve(value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.windowId) && value.windowId > 0
          && Number.isFinite(value.processStartedAt) && value.processStartedAt > 0 && typeof value.title === "string" ? value : null);
      } catch { resolve(null); }
    });
  });
}
