import { execFile } from "node:child_process";
import { desktopCapturer, shell, systemPreferences, type WebContents } from "electron";
import { DESKTOP_COMPUTER_CAPTURE_PATH, DESKTOP_SCREEN_PERMISSION_PATH, DESKTOP_SCREEN_PERMISSION_REPORT_AGENT, isDesktopComputerCaptureTarget, type DesktopComputerCaptureTarget, type DesktopScreenPermissionReason, type DesktopScreenPermissionSnapshot } from "@fleet-console/protocol/desktop";

type WindowVerification = "matches" | "mismatch" | "unknown";

function verifyWindow(executable: string | undefined, target: DesktopComputerCaptureTarget): Promise<WindowVerification> {
  if (!executable) return Promise.resolve("unknown");
  return new Promise<WindowVerification>((resolve) => {
    const { pid, windowId, processStartedAt } = target;
    const body = Buffer.from(JSON.stringify({ version: 1, method: "verifyWindowIdentity", params: { pid, windowId, processStartedAt } }));
    const child = execFile(executable, ["--platform"], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      if (!error) {
        try {
          const result = JSON.parse(stdout);
          const identity = result?.result?.identity;
          if (result?.version === 1 && result.ok === true && (identity === "matches" || identity === "mismatch")) {
            resolve(identity);
            return;
          }
        } catch { /* A malformed reply is not proof of a mismatch. */ }
      }
      resolve("unknown");
    });
    child.stdin?.on("error", () => resolve("unknown"));
    child.stdin?.end(Buffer.concat([Buffer.from(String(body.length).padStart(8, "0")), body]));
  }).catch(() => "unknown");
}

/** 화면 기록 권한 상태. 창 식별 실패와 권한 부족을 같은 로그 줄에서 가르기 위해 붙인다. 묻지 않고 읽기만 한다. */
function screenAccess(): string {
  if (process.platform !== "darwin" && process.platform !== "win32") return "not_applicable";
  try { return systemPreferences.getMediaAccessStatus("screen"); } catch { return "unreadable"; }
}

/** macOS가 화면 기록을 막은 상태만 미리보기 사유가 된다. OS 문자열 자체는 나가지 않는다. */
const SCREEN_RECORDING_BLOCKED = new Set(["denied", "not-determined", "restricted"]);

function screenRecordingReason(): DesktopScreenPermissionReason | null {
  if (process.platform !== "darwin") return null;
  return SCREEN_RECORDING_BLOCKED.has(screenAccess()) ? "screen_recording_permission_required" : null;
}

/** 캡처를 거절하기 전에 사유를 남겨, 렌더러가 실패를 본 뒤에는 이미 읽을 수 있게 한다. 실패해도 캡처 판단은 그대로다. */
async function publishScreenPermission(origin: string, reason: DesktopScreenPermissionReason | null): Promise<boolean> {
  const body: DesktopScreenPermissionSnapshot = { reason };
  try {
    const response = await fetch(`${origin}${DESKTOP_SCREEN_PERMISSION_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin, "User-Agent": DESKTOP_SCREEN_PERMISSION_REPORT_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 사람이 미리보기에서 누를 때만 연다. 주소는 이 상수뿐이고 요청에서 읽지 않는다. */
const SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const SCREEN_SETTINGS_INTERVAL_MS = 5_000;
let lastScreenSettingsAt = 0;

export function openScreenRecordingSettings(log: (message: string) => void, now = Date.now()): void {
  if (process.platform !== "darwin") { log("computer capture screen recording settings ignored: platform"); return; }
  if (now - lastScreenSettingsAt < SCREEN_SETTINGS_INTERVAL_MS) { log("computer capture screen recording settings ignored: repeated"); return; }
  lastScreenSettingsAt = now;
  void shell.openExternal(SCREEN_RECORDING_SETTINGS_URL).then(
    () => log("computer capture screen recording settings opened"),
    () => log("computer capture screen recording settings failed"),
  );
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
export function installComputerCapture(contents: WebContents, localOrigin: () => string | null, log: (message: string) => void, verifierExecutable?: string): void {
  contents.session.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const respond: typeof callback = (streams) => { answered = true; callback(streams); };
    void (async () => {
      const origin = localOrigin();
      // 거절보다 먼저 남긴다. 렌더러의 getDisplayMedia 거부는 이 핸들러가 답을 낸 뒤에야 온다.
      if (origin) {
        const published = await publishScreenPermission(origin, screenRecordingReason());
        if (!published) log("computer capture screen permission unpublished");
      }
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
      // Windows는 목록의 정확한 `window:<hwnd>:0` 존재(HWND 하위 32비트 = Electron 소스 ID)에 더해 헬퍼로 pid+생성시각+HWND 세대를 전후 검증한다.
      const verifiesIdentity = process.platform === "darwin" || process.platform === "win32";
      if (process.platform !== "darwin" && !source) { log(`computer capture rejected: exact window source unavailable, screen permission=${screenAccess()}`); respond({}); return; }
      const matchesWindow = async () => {
        const verification = await verifyWindow(verifierExecutable, target);
        if (verification === "matches") return true;
        const reason = verification === "mismatch" ? "window owner changed or closed" : "window verification unavailable";
        log(`computer capture rejected: ${reason}, screen permission=${screenAccess()}`);
        return false;
      };
      if (verifiesIdentity && !await matchesWindow()) { respond({}); return; }
      const current = await readTarget();
      if (current?.id !== target.id || localOrigin() !== origin) { log("computer capture rejected: selection changed"); respond({}); return; }
      if (verifiesIdentity && !await matchesWindow()) { respond({}); return; }
      log(`computer capture source selected window=${target.windowId} listed=${source ? "yes" : "no"}, screen permission=${screenAccess()}`);
      respond({ video: { id: `window:${target.windowId}:0`, name: target.title } });
    })().catch((error: unknown) => { log(`computer capture failed: ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"}, screen permission=${screenAccess()}`); if (!answered) respond({}); });
  }, { useSystemPicker: false });
}
