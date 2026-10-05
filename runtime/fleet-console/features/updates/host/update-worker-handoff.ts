import type { ChildProcess } from "node:child_process";
import {
  UPDATE_WORKER_ABORT_MS, UPDATE_WORKER_COMMIT_MS, UPDATE_WORKER_HANDSHAKE_VERSION, UPDATE_WORKER_PREFLIGHT_MS,
  isConsoleUpdateWorkerMessage, parseConsoleUpdateFailureReason,
  type ConsoleUpdateFailureReason, type ConsoleUpdateFailureStage, type ConsoleUpdateWorkerMessage,
} from "@fleet-console/protocol/lifecycle";

export type UpdateWorkerChild = Pick<ChildProcess, "pid" | "on" | "once" | "off" | "send" | "connected" | "disconnect" | "kill" | "unref">;

export interface PreparedUpdateWorker {
  readonly accepted: true;
  /** 응답이 끝나기 전에는 호출하지 않는다. worker의 확인 이후에만 self-stop한다. */
  commit(): Promise<void>;
  abort(): Promise<void>;
  /** ready 이후 worker가 인계받지 못한 경우에도 응답 대기와 busy를 끝낸다. */
  readonly cancelled: Promise<void>;
}

/** IPC fd를 가진 실제 child만 상대한다. progress 파일이나 pid만으로 commit을 허용하지 않는다. */
export function prepareUpdateWorker(
  child: UpdateWorkerChild,
  runId: string,
  initialize: () => void,
  failure: (reason: ConsoleUpdateFailureReason | "unknown", stage: ConsoleUpdateFailureStage) => Error,
): Promise<PreparedUpdateWorker> {
  let state: "preflight" | "ready" | "committing" | "committed" | "aborted" = "preflight";
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  let resolveReady!: (value: PreparedUpdateWorker) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<PreparedUpdateWorker>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveCommit: (() => void) | undefined;
  let rejectCommit: ((error: Error) => void) | undefined;
  let aborted: Promise<void> | null = null;
  let timer = setTimeout(() => { void abort("preflight-timeout"); }, UPDATE_WORKER_PREFLIGHT_MS);

  const stage = (): ConsoleUpdateFailureStage => state === "preflight" ? "preflight" : "handoff";
  const send = (kind: ConsoleUpdateWorkerMessage["kind"]): Promise<void> => new Promise((resolve, reject) => {
    if (!child.connected) { reject(new Error("worker disconnected")); return; }
    child.send({ v: UPDATE_WORKER_HANDSHAKE_VERSION, runId, kind }, (error: Error | null) => error ? reject(error) : resolve());
  });

  function abort(reason: ConsoleUpdateFailureReason | "unknown", failureStage = stage()): Promise<void> {
    if (state === "committed") return Promise.resolve();
    if (aborted) return aborted;
    state = "aborted";
    clearTimeout(timer);
    aborted = (async () => {
      // 종료할 때까지 다음 실행을 받지 않는다. 늦은 worker가 새 progress를 덮을 수 없게 한다.
      if (!exited) {
        void send("abort").catch(() => {});
        const kill = setTimeout(() => {
          // 아직 수거하지 않은 자신의 child handle(E1)만 종료한다.
          if (!exited) {
            if (process.platform !== "win32" && child.pid !== undefined) {
              try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
              }
            } else child.kill("SIGKILL");
          }
        }, UPDATE_WORKER_ABORT_MS);
        await exit;
        clearTimeout(kill);
      }
      cleanup();
      const error = failure(reason, failureStage);
      rejectReady(error);
      rejectCommit?.(error);
      resolveCancelled();
    })();
    return aborted;
  }

  function cleanup(): void {
    clearTimeout(timer);
    child.off("message", onMessage);
    child.off("disconnect", onDisconnect);
    if (child.connected) child.disconnect();
    child.unref();
  }
  function onDisconnect(): void {
    if (state !== "committed") void abort("handoff-aborted");
  }
  function onMessage(value: unknown): void {
    if (!isConsoleUpdateWorkerMessage(value, runId, UPDATE_WORKER_HANDSHAKE_VERSION)) return;
    if (value.kind === "failed") {
      const parsed = parseConsoleUpdateFailureReason(value.reason);
      void abort(parsed ?? "unknown", value.failureStage === "handoff" ? "handoff" : stage());
    } else if (value.kind === "ready" && state === "preflight") {
      state = "ready";
      clearTimeout(timer);
      timer = setTimeout(() => { void abort("handoff-aborted"); }, UPDATE_WORKER_COMMIT_MS);
      resolveReady({
        accepted: true,
        cancelled,
        abort: () => abort("handoff-aborted"),
        commit: () => {
          if (state !== "ready") return aborted ? aborted.then(() => { throw new Error("update handoff aborted"); }) : Promise.reject(new Error("update handoff not ready"));
          state = "committing";
          return new Promise<void>((resolve, reject) => {
            resolveCommit = resolve;
            rejectCommit = reject;
            void send("commit").catch(() => abort("handoff-aborted"));
          });
        },
      });
    } else if (value.kind === "committed" && state === "committing") {
      state = "committed";
      cleanup();
      resolveCommit?.();
    }
  }
  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  child.once("exit", () => {
    exited = true;
    resolveExit();
    if (state !== "committed" && state !== "aborted") void abort("worker-lost");
  });
  child.once("error", () => {
    // spawn 오류에는 exit가 오지 않을 수 있다.
    if (child.pid === undefined) {
      exited = true;
      resolveExit();
    }
    void abort("worker-lost");
  });
  try {
    initialize();
    void send("prepare").catch(() => abort("handoff-aborted"));
  } catch {
    void abort("preflight-failed");
  }
  return ready;
}
