import { execFile } from "node:child_process";
import { desktopCapturer, systemPreferences, type WebContents } from "electron";
import { DESKTOP_COMPUTER_CAPTURE_PATH, isDesktopComputerCaptureTarget, type DesktopComputerCaptureTarget } from "@fleet-console/protocol/desktop";

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
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", VERIFY_WINDOW, String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

/** 화면 기록 권한 상태. 창 식별 실패와 권한 부족을 같은 로그 줄에서 가르기 위해 붙인다. 묻지 않고 읽기만 한다. */
function screenAccess(): string {
  if (process.platform !== "darwin" && process.platform !== "win32") return "not_applicable";
  try { return systemPreferences.getMediaAccessStatus("screen"); } catch { return "unreadable"; }
}

/** 같은 클릭이 겹쳐 와도 OS 안내를 거듭 띄우지 않는 간격. */
const ACCESSIBILITY_REQUEST_INTERVAL_MS = 5_000;
let lastAccessibilityRequestAt = 0;

/**
 * 화면공유 창 식별에 필요한 손쉬운 사용 권한을 이 앱 이름으로 묻는다. Console은 이 앱이 띄운 자식이라 TCC가 그 자식(osascript)의
 * AX 호출을 이 앱의 허용으로 판정한다. 이미 신뢰받으면 안내 없이 true다. 사람이 미리보기에서 누른 요청만 이 길로 온다.
 */
export function requestAccessibilityPermission(log: (message: string) => void, now = Date.now()): void {
  if (process.platform !== "darwin") { log("computer capture accessibility request ignored: platform"); return; }
  if (now - lastAccessibilityRequestAt < ACCESSIBILITY_REQUEST_INTERVAL_MS) { log("computer capture accessibility request ignored: repeated"); return; }
  lastAccessibilityRequestAt = now;
  let trusted: boolean | "unreadable";
  try { trusted = systemPreferences.isTrustedAccessibilityClient(true); } catch { trusted = "unreadable"; }
  log(`computer capture accessibility requested trusted=${trusted}`);
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
      if (!target) { log(`computer capture rejected: window identity unavailable, screen permission=${screenAccess()}`); respond({}); return; }
      // Electron 자신의 TCC 요청을 거친다. 목록은 floating 창을 생략할 수 있어 식별의 근거가 아니다.
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(source => source.id === `window:${target.windowId}:0`);
      if (process.platform !== "darwin" && !source) { log(`computer capture rejected: exact window source unavailable, screen permission=${screenAccess()}`); respond({}); return; }
      if (process.platform === "darwin" && !await verifyWindow(target)) { log(`computer capture rejected: window owner changed or closed, screen permission=${screenAccess()}`); respond({}); return; }
      const current = await readTarget();
      if (current?.id !== target.id || localOrigin() !== origin || (process.platform === "darwin" && !await verifyWindow(target))) { log("computer capture rejected: selection changed"); respond({}); return; }
      log(`computer capture source selected window=${target.windowId} listed=${source ? "yes" : "no"}, screen permission=${screenAccess()}`);
      respond({ video: { id: `window:${target.windowId}:0`, name: target.title } });
    })().catch((error: unknown) => { log(`computer capture failed: ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"}, screen permission=${screenAccess()}`); if (!answered) respond({}); });
  }, { useSystemPicker: false });
}
