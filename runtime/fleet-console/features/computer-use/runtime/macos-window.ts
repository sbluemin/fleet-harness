import { execFile } from "node:child_process";
import type { ComputerUseWindowIdentity, ComputerUseWindowState, ComputerUseOpenResult } from "./platform.js";

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

const WINDOW_IDENTITY = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(args) {
  var pid=Number(args[0]), id=Number(args[1]), started=Number(args[2]);
  var process=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!process || process.hidden || Number(process.launchDate.timeIntervalSince1970)!==started) return 'false';
  var windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));
  return JSON.stringify(windows.some(w=>w.kCGWindowOwnerPID===pid&&w.kCGWindowNumber===id));
}`;

export function verifyMacWindowIdentity(target: ComputerUseWindowIdentity): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_IDENTITY, String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

const READ_PERMISSIONS = `
ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
JSON.stringify({ accessibility: Boolean($.AXIsProcessTrusted()), screenRecording: Boolean($.CGPreflightScreenCaptureAccess()) });`;

export async function readMacPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean } | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", READ_PERMISSIONS], { timeout: 3000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      if (!error) {
        try {
          const value = JSON.parse(stdout);
          if (typeof value.accessibility === "boolean" && typeof value.screenRecording === "boolean") { resolve(value); return; }
        } catch { /* An unavailable probe is not a denial. */ }
      }
      resolve(null);
    });
  });
}

export async function openMacPrivacySettings(missing: readonly ("accessibility" | "screenRecording")[]): Promise<boolean> {
  if (process.platform !== "darwin" || !missing.length) return false;
  const pane = missing.length > 1 ? "Privacy" : missing[0] === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
  return new Promise((resolve) => {
    execFile("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${pane}`], { timeout: 3000, windowsHide: true }, (error) => resolve(!error));
  });
}
