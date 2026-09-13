import { execFile } from "node:child_process";
import { ComputerUseInputError, type ComputerUseWindowIdentity } from "./computer-use-platform.js";

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

export async function assertMacInteractionReadiness(app: string, allowActivation: boolean): Promise<void> {
  if (allowActivation) return;
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
    if (!process || Number(process.launchDate.timeIntervalSince1970)!==started) return 'false';
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
