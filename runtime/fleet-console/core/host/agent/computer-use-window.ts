import { execFile } from "node:child_process";
import type { ComputerUseWindowIdentity } from "./computer-use-platform.js";

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
  if ($.AXUIElementCopyAttributeValue(app,$('AXFocusedWindow'),focused)!==0) return 'null';
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
      if (error) { process.stderr.write(`[fleet-computer-use] window identity unavailable: ${error.message}\n`); resolve(null); return; }
      try {
        const value = JSON.parse(stdout) as ComputerUseWindowIdentity | null;
        resolve(value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.windowId) && value.windowId > 0
          && Number.isFinite(value.processStartedAt) && value.processStartedAt > 0 && typeof value.title === "string" ? value : null);
      } catch { resolve(null); }
    });
  });
}
