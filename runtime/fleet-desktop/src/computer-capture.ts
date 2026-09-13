import { execFile } from "node:child_process";
import { desktopCapturer, nativeImage, systemPreferences, type WebContents } from "electron";
import { DESKTOP_COMPUTER_CAPTURE_PATH, isDesktopComputerCaptureTarget, type DesktopComputerCaptureTarget } from "@fleet-console/desktop-protocol";

const WINDOW_INVENTORY = 'ObjC.import("CoreGraphics"); ObjC.import("Foundation"); var rows=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)); JSON.stringify(ObjC.deepUnwrap(rows).map(w=>({pid:w.kCGWindowOwnerPID,id:w.kCGWindowNumber,name:w.kCGWindowName})))';

async function windowId(target: DesktopComputerCaptureTarget, log: (message: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_INVENTORY], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { log(`computer capture inventory failed: ${error.message}`); resolve(null); return; }
      try {
        const rows: unknown = JSON.parse(stdout);
        if (!Array.isArray(rows)) { resolve(null); return; }
        const matches = rows.filter((row) => row && row.pid === target.pid && row.name === target.title && Number.isSafeInteger(row.id));
        if (matches.length !== 1) log(`computer capture inventory mismatch: ${JSON.stringify({ ownerWindows: rows.filter((row) => row?.pid === target.pid).length, titleMatches: matches.length })}`);
        resolve(matches.length === 1 ? matches[0].id : null);
      } catch { resolve(null); }
    });
  });
}

/** Console가 관찰한 PID와 창 제목을 OS 소유자 목록으로 확인한 뒤 그 창만 선택한다. */
export function installComputerCapture(contents: WebContents, localOrigin: () => string | null, log: (message: string) => void): void {
  contents.session.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const respond: typeof callback = (streams) => { answered = true; callback(streams); };
    void (async () => {
      const origin = localOrigin();
      if (process.platform !== "darwin" || !origin || request.frame !== contents.mainFrame || !request.videoRequested || request.audioRequested) { log("computer capture rejected: request scope"); respond({}); return; }
      const readTarget = async () => {
        const response = await fetch(`${origin}${DESKTOP_COMPUTER_CAPTURE_PATH}`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return null;
        const body = await response.json() as { target?: unknown };
        return isDesktopComputerCaptureTarget(body.target) ? body.target : null;
      };
      const target = await readTarget();
      if (!target) { log("computer capture rejected: target unavailable"); respond({}); return; }
      // Electron 자신의 TCC 요청을 먼저 거친다. 자식 osascript의 창 조회로는 앱의 권한 요청이 시작되지 않는다.
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
      const id = await windowId(target, log);
      if (id === null) { log(`computer capture rejected: window unmatched, screen permission=${systemPreferences.getMediaAccessStatus("screen")}`); respond({}); return; }
      // Electron의 목록은 floating 창을 생략하지만 window capturer는 그 CGWindowID를 지원한다.
      // 목록 누락을 다른 창 선택으로 보완하지 않고, PID·제목이 유일하게 일치한 그 창만 지정한다.
      const source = sources.find((source) => source.id.split(":")[1] === String(id))
        ?? { id: `window:${id}:0`, name: target.title, thumbnail: nativeImage.createEmpty(), display_id: "", appIcon: null };
      const current = await readTarget();
      if (current?.id !== target.id || localOrigin() !== origin || await windowId(target, log) !== id) { log(`computer capture rejected: current=${current?.id === target.id}`); respond({}); return; }
      log("computer capture source selected");
      respond({ video: source });
    })().catch((error: unknown) => { log(`computer capture failed: ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"}, screen permission=${systemPreferences.getMediaAccessStatus("screen")}`); if (!answered) respond({}); });
  }, { useSystemPicker: false });
}
