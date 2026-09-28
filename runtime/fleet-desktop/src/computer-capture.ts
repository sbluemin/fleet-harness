import { execFile } from "node:child_process";
import { desktopCapturer, systemPreferences, type Session, type WebContents } from "electron";
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
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", VERIFY_WINDOW, String(target.pid), String(target.windowId), String(target.processStartedAt)], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => resolve(!error && stdout.trim() === "true"));
  });
}

/** 화면 캡처를 받을 수 있는 뷰 하나 — 로컬 뷰가 권한을 가진 동안의 그 뷰와 전환 세대. */
export interface CaptureAuthority {
  readonly contents: WebContents;
  readonly origin: string;
  readonly generation: number;
}

export interface ComputerCapture {
  /** 떠나기 전에, 아직 답하지 않은 요청을 모두 거절로 끝낸다. 늦게 끝난 요청이 떠난 뒤에 트랙을 만들지 않게. */
  abortPending(reason: string): void;
}

/**
 * Console가 관찰 시 확보한 창 ID와 프로세스 수명을 검증한다. 제목으로 다른 창을 찾지 않는다.
 *
 * 핸들러는 세션에 하나다 — 두 콘솔 뷰와 덮개가 같은 세션을 쓰므로, 누가 받을 수 있는지는 `authority`가
 * 요청을 시작할 때와 답하기 직전에 한 번씩 정한다. 그 사이 전환이 시작됐다면(세대가 바뀌었다면) 거절한다.
 */
export function installComputerCapture(session: Pick<Session, "setDisplayMediaRequestHandler">, authority: () => CaptureAuthority | null, log: (message: string) => void): ComputerCapture {
  const pending = new Set<(reason: string) => void>();
  session.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const respond: typeof callback = (streams) => {
      if (answered) return;
      answered = true;
      pending.delete(abort);
      callback(streams);
    };
    const abort = (reason: string): void => { if (!answered) { log(`computer capture rejected: ${reason}`); respond({}); } };
    pending.add(abort);
    void (async () => {
      const holder = authority();
      if (!holder || request.frame !== holder.contents.mainFrame || !request.videoRequested || request.audioRequested) { log("computer capture rejected: request scope"); respond({}); return; }
      const origin = holder.origin;
      const stillHolds = (): boolean => {
        const current = authority();
        return current !== null && current.contents === holder.contents && current.origin === origin && current.generation === holder.generation;
      };
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
      if (current?.id !== target.id || (process.platform === "darwin" && !await verifyWindow(target))) { log("computer capture rejected: selection changed"); respond({}); return; }
      if (!stillHolds()) { log("computer capture rejected: surface changed"); respond({}); return; }
      log(`computer capture source selected window=${target.windowId}`);
      respond({ video: { id: `window:${target.windowId}:0`, name: target.title } });
    })().catch((error: unknown) => { log(`computer capture failed: ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"}, screen permission=${systemPreferences.getMediaAccessStatus("screen")}`); respond({}); });
  }, { useSystemPicker: false });
  return {
    abortPending(reason) {
      for (const abort of [...pending]) abort(reason);
    },
  };
}
