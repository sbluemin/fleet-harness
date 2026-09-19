import type * as http from "node:http";
import crypto from "node:crypto";
import { ConsoleReleaseNotesUnavailableError, type ConsoleReleaseNotesService, type ReleaseNotesLocale } from "./release-notes/release-notes.js";
import { IDLE_CONSOLE_UPDATE_PROGRESS, readConsoleUpdateProgress, type ConsoleUpdateProgressStatus } from "./update-progress.js";
import type { ConsoleUpdateCheckService, ConsoleUpdateStatus } from "./update-check.js";
import { isManagedRuntimePackageRoot, type ConsoleUpdateApplyService } from "./update-apply.js";
import type { ConsoleUpdateApplyAcceptedResponse, ConsoleUpdateApplyError } from "../../../core/host/transport/console-contract-types.js";

type UpdateApplyBody = Record<string, unknown>;
const UPDATE_APPLY_FORBIDDEN_BODY_KEYS = new Set(["channel", "package", "packageName", "packageVersion", "packages", "targetVersion", "version"]);
interface UpdatesRouteDeps {
  readonly releaseNotes: ConsoleReleaseNotesService;
  readonly updateCheck: ConsoleUpdateCheckService;
  readonly updateApply: ConsoleUpdateApplyService;
  readonly durablePaths: { readonly dir: string };
  readonly release: { readonly packageRoot: string };
  readonly version: string;
  readonly channel: string;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly readUrl: (req: http.IncomingMessage) => URL;
  readonly currentRuntime: () => { readonly lockHandle: unknown; readonly activeEndpoint: string | null; readonly activeLockFile: string | null };
  readonly publishDesktopUpdateRequest: (request: { readonly requestedVersion: string; readonly requestId: string }) => void;
  readonly stopAfterAcceptedUpdateApply: () => Promise<void>;
}
export function createUpdatesRoutes(deps: UpdatesRouteDeps) {
  const { releaseNotes, updateCheck, updateApply, durablePaths, release, version, channel, isExactConsoleOrigin, isLoopbackListener, readJsonBody, writeJson, readUrl, currentRuntime, publishDesktopUpdateRequest, stopAfterAcceptedUpdateApply } = deps;
  let updateApplyInFlight = false;
  async function handleObserverReleaseNotes(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const searchParams = readUrl(req).searchParams;
      const force = searchParams.get("force") === "true";
      const locale: ReleaseNotesLocale = searchParams.get("locale") === "ko" ? "ko" : "en";
      writeJson(res, 200, await releaseNotes.refresh({ force, locale }));
    } catch (error) {
      if (error instanceof ConsoleReleaseNotesUnavailableError) {
        writeJson(res, 503, { error: "release_notes_unavailable" });
        return;
      }
      throw error;
    }
  }

  /**
   * 업데이트가 끝났는지 말해 줄 수 있는 것은 그 업데이트를 겪은 프로세스가 아니다 —
   * 그 프로세스는 이미 죽었다. 답하는 쪽은 **다음 세대의 데몬**이고, 근거는 워커가
   * 디스크에 남긴 기록이다. 그래서 이 라우트는 자기 메모리를 읽지 않는다.
   */
  function handleUpdateProgress(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    let progress: ConsoleUpdateProgressStatus;
    try {
      progress = readConsoleUpdateProgress(durablePaths.dir);
    } catch {
      progress = IDLE_CONSOLE_UPDATE_PROGRESS;
    }
    writeJson(res, 200, progress);
  }

  /**
   * 사용자가 "지금 확인"을 눌렀다. 캐시 TTL을 기다리게 하지 않고 레지스트리를 한 번 다시 묻는다.
   * 결과가 달라지면 기존 변경 리스너가 관찰자들에게 알리고, 같으면 이 응답만이 답이다 —
   * 그래서 응답에 상태를 그대로 싣는다.
   */
  async function handleUpdateCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isExactConsoleOrigin(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    // 조회 실패를 "최신"으로 답하면 안 된다 — 사용자는 방금 확인을 눌렀고, 답은 셋 중 하나다: 새 버전, 최신, 모름.
    let status: ConsoleUpdateStatus;
    try {
      status = updateCheck.check ? await updateCheck.check() : await updateCheck.refresh({ force: true });
    } catch {
      writeJson(res, 503, { error: "registry_unreachable" });
      return;
    }
    writeJson(res, 200, { updateAvailable: status.updateAvailable, ...(status.latestVersion ? { latestVersion: status.latestVersion } : {}) });
  }

  async function handleUpdateApply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isExactConsoleOrigin(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<UpdateApplyBody>(req);
    if (body === null && requestHasBody(req)) {
      writeJson(res, 400, { error: "invalid_update_apply_body" });
      return;
    }
    if (body !== null && (!isPlainObject(body) || hasForbiddenUpdateApplyBodyKeys(body))) {
      writeJson(res, 400, { error: "invalid_update_apply_body" });
      return;
    }
    if (channel === "local") {
      writeJson(res, 403, { error: "local_channel" });
      return;
    }
    if (updateApplyInFlight) {
      writeJson(res, 409, { error: "update_already_in_progress" });
      return;
    }
    const freshStatus = await updateCheck.refresh({ force: true });
    if (!freshStatus.updateAvailable || !freshStatus.latestVersion) {
      writeJson(res, 409, { error: "update_not_available" });
      return;
    }
    // 원격에서 누른 손은 이 기계 앞에 없다. 이 콘솔을 내리는 일은 그 자리에 앉아 있는
    // 사람의 화면까지 함께 내리므로, 원격 리스너로 들어온 요청은 그 사실을 읽고 나서만
    // 진행한다. 보안 관문이 아니라 고의성의 표식이다 — 관문은 이미 세션이 지켰다.
    if (!isLoopbackListener(req) && (body === null || body.acknowledgeHostRestart !== true)) {
      writeJson(res, 409, { error: "host_restart_confirmation_required" });
      return;
    }
    // 이 트리를 제자리에서 고칠 수 없는 설치 레이아웃이라면, 업데이트를 거절하는 대신
    // 창을 들고 있는 셸에게 넘긴다. 거절은 사용자를 아무 데도 데려가지 않았다.
    if (isManagedRuntimePackageRoot(release.packageRoot)) {
      publishDesktopUpdateRequest({ requestedVersion: freshStatus.latestVersion, requestId: crypto.randomUUID() });
      const delegated: ConsoleUpdateApplyAcceptedResponse = { status: "delegated" };
      writeJson(res, 202, delegated);
      return;
    }
    const { lockHandle: handle, activeEndpoint, activeLockFile } = currentRuntime();
    if (!handle || !activeEndpoint || !activeLockFile) {
      writeJson(res, 503, { error: "console_not_ready" });
      return;
    }
    updateApplyInFlight = true;
    try {
      await updateApply.start({
        currentEndpoint: activeEndpoint,
        currentPackageRoot: release.packageRoot,
        currentPid: process.pid,
        dataDir: durablePaths.dir,
        fromVersion: version,
        lockFile: activeLockFile,
        targetVersion: freshStatus.latestVersion,
      });
    } catch (error) {
      updateApplyInFlight = false;
      const updateError: ConsoleUpdateApplyError = error instanceof Error && error.message === "managed_runtime_update_requires_relaunch"
        ? "managed_runtime_update_requires_relaunch"
        : "update_worker_unavailable";
      writeJson(res, 503, { error: updateError });
      return;
    }
    res.once("finish", () => {
      setImmediate(() => {
        void stopAfterAcceptedUpdateApply();
      });
    });
    const payload: ConsoleUpdateApplyAcceptedResponse = { status: "accepted" };
    writeJson(res, 202, payload);
  }

  return { handleObserverReleaseNotes, handleUpdateProgress, handleUpdateCheck, handleUpdateApply };
}
function requestHasBody(req: http.IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && contentLength !== "0") return true;
  return req.headers["transfer-encoding"] !== undefined;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasForbiddenUpdateApplyBodyKeys(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => UPDATE_APPLY_FORBIDDEN_BODY_KEYS.has(key));
}
