import type * as http from "node:http";
import crypto from "node:crypto";
import { ConsoleReleaseNotesUnavailableError, type ConsoleReleaseNotesService, type ReleaseNotesLocale } from "./release-notes/release-notes.js";
import { IDLE_CONSOLE_UPDATE_PROGRESS, readConsoleUpdateProgress, type ConsoleUpdateProgressStatus } from "./update-progress.js";
import type { ConsoleUpdateCheckService, ConsoleUpdateStatus } from "./update-check.js";
import { hasDesktopGithubReleaseConsoleSource } from "@fleet-console/protocol/desktop";
import { isManagedRuntimePackageRoot, type ConsoleUpdateApplyService } from "./update-apply.js";
import type { ConsoleUpdateApplyAcceptedResponse, ConsoleUpdateApplyError } from "../../../core/host/transport/console-contract-types.js";

type UpdateApplyBody = Record<string, unknown>;
// The body may only acknowledge; where the update comes from and what it installs is never the caller's to name.
const UPDATE_APPLY_FORBIDDEN_BODY_KEYS = new Set(["channel", "package", "packageName", "packageVersion", "packages", "tag", "targetVersion", "url", "version"]);
const UPDATE_APPLY_START_ERRORS: ReadonlySet<ConsoleUpdateApplyError> = new Set<ConsoleUpdateApplyError>(["managed_runtime_update_requires_relaunch", "download_failed", "checksum_mismatch"]);
/**
 * 셸에 넘긴 업데이트는 성공하면 이 프로세스째 사라지므로 끝났다는 소식이 오지 않는다. 오지 않은 채
 * 이만큼 지나면 셸이 재시작하지 않은 것으로 보고 다시 받는다 — 화면이 기다림을 거두는 시간과 같다.
 */
const DELEGATED_UPDATE_HOLD_MS = 60_000;
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
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly stopAfterAcceptedUpdateApply: () => Promise<void>;
}
export function createUpdatesRoutes(deps: UpdatesRouteDeps) {
  const { releaseNotes, updateCheck, updateApply, durablePaths, release, version, channel, isExactConsoleOrigin, isLoopbackListener, readJsonBody, writeJson, readUrl, currentRuntime, publishDesktopUpdateRequest, stopAfterAcceptedUpdateApply } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  // 한 Console에 업데이트는 한 번에 하나다. 두 탭이 함께 눌러도 Release 재확인을 기다리는 사이에
  // 둘 다 통과하지 않도록, 요청은 첫 await 전에 자리를 잡는다.
  let updateApplyInFlight = false;
  let delegatedAt: number | null = null;
  function updateApplyBusy(): boolean {
    if (updateApplyInFlight) return true;
    if (delegatedAt !== null && now() - delegatedAt <= DELEGATED_UPDATE_HOLD_MS) return true;
    delegatedAt = null;
    return false;
  }
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
   * 사용자가 "지금 확인"을 눌렀다. 캐시 TTL을 기다리게 하지 않고 Release를 한 번 다시 묻는다.
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
    writeJson(res, 200, {
      updateAvailable: status.updateAvailable,
      ...(status.latestVersion ? { latestVersion: status.latestVersion } : {}),
      ...(status.shellUpdateRequired ? { shellUpdateRequired: true } : {}),
    });
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
    if (updateApplyBusy()) {
      writeJson(res, 409, { error: "update_already_in_progress" });
      return;
    }
    updateApplyInFlight = true;
    let accepted = false;
    try {
      accepted = await claimedUpdateApply(req, res, body);
    } finally {
      // 받아들여진 제자리 업데이트는 이 프로세스를 내린다. 그 밖의 모든 끝에서는 자리를 비운다.
      if (!accepted) updateApplyInFlight = false;
    }
  }

  /** 자리를 잡은 요청을 끝까지 처리한다. 이 Console을 내리는 업데이트를 시작했을 때만 true다. */
  async function claimedUpdateApply(req: http.IncomingMessage, res: http.ServerResponse, body: UpdateApplyBody | null): Promise<boolean> {
    const freshStatus = await updateCheck.refresh({ force: true });
    if (!freshStatus.updateAvailable || !freshStatus.latestVersion) {
      writeJson(res, 409, { error: "update_not_available" });
      return false;
    }
    // 원격에서 누른 손은 이 기계 앞에 없다. 이 콘솔을 내리는 일은 그 자리에 앉아 있는
    // 사람의 화면까지 함께 내리므로, 원격 리스너로 들어온 요청은 그 사실을 읽고 나서만
    // 진행한다. 보안 관문이 아니라 고의성의 표식이다 — 관문은 이미 세션이 지켰다.
    if (!isLoopbackListener(req) && (body === null || body.acknowledgeHostRestart !== true)) {
      writeJson(res, 409, { error: "host_restart_confirmation_required" });
      return false;
    }
    // 이 트리를 제자리에서 고칠 수 없는 설치 레이아웃이라면, 업데이트를 거절하는 대신
    // 창을 들고 있는 셸에게 넘긴다. 거절은 사용자를 아무 데도 데려가지 않았다.
    if (isManagedRuntimePackageRoot(release.packageRoot)) {
      // 그러나 Release에서 받을 줄 모르는 옛 셸에게 넘기면 셸은 npm에서 다시 설치한다. 그 셸은
      // 먼저 바뀌어야 한다 — 이 규칙은 한 번의 다리가 아니라 새 업데이터의 영구 규칙이다.
      if (!hasDesktopGithubReleaseConsoleSource(env)) {
        writeJson(res, 409, { error: "shell_update_required" });
        return false;
      }
      // 요청표 하나가 셸의 재시작 한 번이다. 셸이 재시작하는 사이 다른 탭이 누르면 새 표 대신
      // 이미 진행 중이라는 답을 받는다.
      delegatedAt = now();
      publishDesktopUpdateRequest({ requestedVersion: freshStatus.latestVersion, requestId: crypto.randomUUID() });
      const delegated: ConsoleUpdateApplyAcceptedResponse = { status: "delegated" };
      writeJson(res, 202, delegated);
      return false;
    }
    const latestRelease = updateCheck.latestRelease?.() ?? null;
    if (latestRelease === null || latestRelease.version !== freshStatus.latestVersion) {
      writeJson(res, 409, { error: "update_not_available" });
      return false;
    }
    const { lockHandle: handle, activeEndpoint, activeLockFile } = currentRuntime();
    if (!handle || !activeEndpoint || !activeLockFile) {
      writeJson(res, 503, { error: "console_not_ready" });
      return false;
    }
    try {
      await updateApply.start({
        currentEndpoint: activeEndpoint,
        currentPackageRoot: release.packageRoot,
        currentPid: process.pid,
        dataDir: durablePaths.dir,
        fromVersion: version,
        lockFile: activeLockFile,
        release: latestRelease,
      });
    } catch (error) {
      // 다운로드·검증 실패는 콘솔을 내리기 전에 난다. 콘솔은 그대로 서 있고 사용자는 이유를 읽는다.
      const message = error instanceof Error ? error.message : "";
      const updateError: ConsoleUpdateApplyError = UPDATE_APPLY_START_ERRORS.has(message as ConsoleUpdateApplyError)
        ? (message as ConsoleUpdateApplyError)
        : "update_worker_unavailable";
      writeJson(res, 503, { error: updateError });
      return false;
    }
    res.once("finish", () => {
      setImmediate(() => {
        void stopAfterAcceptedUpdateApply();
      });
    });
    const payload: ConsoleUpdateApplyAcceptedResponse = { status: "accepted" };
    writeJson(res, 202, payload);
    return true;
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
