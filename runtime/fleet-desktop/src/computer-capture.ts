import { execFile } from "node:child_process";
import { desktopCapturer, systemPreferences, type WebContents } from "electron";
import { DESKTOP_COMPUTER_CAPTURE_PATH, isDesktopComputerCaptureTarget, type DesktopComputerCaptureTarget } from "@fleet-console/desktop-protocol";

const VERIFY_WINDOW = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(args) {
  var pid=Number(args[0]), id=Number(args[1]), started=Number(args[2]);
  var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.hidden || Number(app.launchDate.timeIntervalSince1970)!==started) return 'false';
  var rows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));
  return JSON.stringify(rows.some(w=>w.kCGWindowOwnerPID===pid && w.kCGWindowNumber===id));
}`;

async function verifyWindow(target: DesktopComputerCaptureTarget): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", VERIFY_WINDOW, String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

/** Console가 관찰 시 확보한 창 ID와 프로세스 수명을 검증한다. 제목으로 다른 창을 찾지 않는다. */
export function installComputerCapture(contents: WebContents, localOrigin: () => string | null, log: (message: string) => void): void {
  contents.session.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const respond: typeof callback = (streams) => { answered = true; callback(streams); };
    void (async () => {
      const origin = localOrigin();
      if (!origin || request.frame !== contents.mainFrame || !request.videoRequested || request.audioRequested) { log("computer capture rejected: request scope"); respond({}); return; }
      const readTarget = async () => {
        const response = await fetch(`${origin}${DESKTOP_COMPUTER_CAPTURE_PATH}`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return null;
        const body = await response.json() as { target?: unknown };
        return isDesktopComputerCaptureTarget(body.target) ? body.target : null;
      };
      const target = await readTarget();
      if (!target) { log("computer capture rejected: window identity unavailable"); respond({}); return; }
      // Electron 자신의 TCC 요청을 거친다. 목록은 floating 창을 생략할 수 있어 식별의 근거가 아니다.
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(source => source.id === `window:${target.windowId}:0`);
      if (process.platform !== "darwin" && !source) { log("computer capture rejected: exact window source unavailable"); respond({}); return; }
      if (process.platform === "darwin" && !await verifyWindow(target)) { log("computer capture rejected: window owner changed or closed"); respond({}); return; }
      const current = await readTarget();
      if (current?.id !== target.id || localOrigin() !== origin || (process.platform === "darwin" && !await verifyWindow(target))) { log("computer capture rejected: selection changed"); respond({}); return; }
      log(`computer capture source selected window=${target.windowId}`);
      respond({ video: { id: `window:${target.windowId}:0`, name: target.title } });
    })().catch((error: unknown) => { log(`computer capture failed: ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"}, screen permission=${systemPreferences.getMediaAccessStatus("screen")}`); if (!answered) respond({}); });
  }, { useSystemPicker: false });
}
