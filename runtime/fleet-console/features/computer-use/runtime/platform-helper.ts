import type { ChildProcess } from "node:child_process";
import { isRecord } from "./platform.js";
import type { ClipboardLease, ClipboardRestoration } from "./platform.js";

export const COMPUTER_USE_PLATFORM_VERSION = 1;
const MAX_REPLY_BYTES = 4096;

type Spawn = (args: readonly string[]) => ChildProcess;

function frame(request: object, limit: number): Buffer {
  const body = Buffer.from(JSON.stringify({ ...request, version: COMPUTER_USE_PLATFORM_VERSION }));
  if (body.length < 1 || body.length > limit) throw new Error("computer_use_helper_input_size");
  return Buffer.concat([Buffer.from(String(body.length).padStart(8, "0")), body]);
}

/** Neither stderr nor failed reply data can enter errors or diagnostics. */
function exchange(spawn: Spawn, mode: "--platform" | "--paste-lease", bytes: Buffer, handlers: {
  reply(row: Record<string, unknown>): void;
  close(exitCode: number | null): void;
  fail(): void;
}, maxReplyBytes = MAX_REPLY_BYTES) {
  const child = spawn([mode]);
  let received = 0;
  let output = "";
  let closed = false;
  let killing: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { if (!closed) child.kill("SIGKILL"); };
  const finish = (grace: number) => {
    if (closed) return;
    child.stdin?.end();
    if (!killing) { killing = setTimeout(terminate, grace); killing.unref(); }
  };
  child.stderr?.resume();
  child.once("close", (code) => {
    closed = true;
    clearTimeout(killing);
    handlers.close(output ? null : code);
  });
  child.on("error", handlers.fail);
  child.stdin?.on("error", handlers.fail);
  child.stdout?.on("error", handlers.fail);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    received += Buffer.byteLength(chunk);
    if (received > maxReplyBytes) { handlers.fail(); return; }
    output += chunk;
    for (let newline; (newline = output.indexOf("\n")) !== -1;) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try {
        const row: unknown = JSON.parse(line);
        if (!isRecord(row) || row.version !== COMPUTER_USE_PLATFORM_VERSION) { handlers.fail(); return; }
        handlers.reply(row);
      } catch { handlers.fail(); return; }
    }
  });
  if (mode === "--platform") child.stdin?.end(bytes);
  else child.stdin?.write(bytes);
  return finish;
}

export async function callPlatform(spawn: Spawn, method: string, params: object, timeout: number, signal?: AbortSignal, options?: { maxReplyBytes?: number; onUnsupported?: () => void }): Promise<Record<string, unknown> | null> {
  if (signal?.aborted) return null;
  try {
    const bytes = frame({ method, params }, 65_536);
    return await new Promise((resolve) => {
      let result: Record<string, unknown> | null = null;
      let received = false;
      const settle = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        resolve(value);
      };
      const fail = () => { stop(0); settle(null); };
      const stop = exchange(spawn, "--platform", bytes, {
        reply: (row) => {
          if (!received && row.ok === false && row.error === "unknown_method") options?.onUnsupported?.();
          if (received || row.ok !== true || !isRecord(row.result)) { fail(); return; }
          received = true;
          result = row.result;
        },
        close: (code) => settle(code === 0 ? result : null),
        fail,
      }, options?.maxReplyBytes);
      const timer = setTimeout(fail, timeout);
      timer.unref();
      signal?.addEventListener("abort", fail, { once: true });
      if (signal?.aborted) fail();
    });
  } catch { return null; }
}

export async function prepareClipboardLease(spawn: Spawn, payload: { readonly text: string; readonly html?: string }, signal: AbortSignal): Promise<ClipboardLease> {
  const unavailable = () => new Error("computer_use_clipboard_prepare_failed");
  if (signal.aborted) throw unavailable();
  const bytes = frame(payload, 2_000_000);
  let ready: (ready: boolean) => void = () => {};
  let closed: (restoration: ClipboardRestoration) => void = () => {};
  let started = false;
  let finishing = false;
  let replySeen = false;
  let restoration: ClipboardRestoration = "failed";
  const prepared = new Promise<boolean>((resolve) => { ready = resolve; });
  const finished = new Promise<ClipboardRestoration>((resolve) => { closed = resolve; });
  const release = () => {
    if (finishing) return;
    finishing = true;
    stop(5000);
    ready(false);
  };
  const stop = exchange(spawn, "--paste-lease", bytes, {
    reply: (row) => {
      if (!started && !finishing && row.ready === true) {
        started = true;
        clearTimeout(prepareTimer);
        signal.removeEventListener("abort", release);
        ready(true);
      } else if (!replySeen && (row.restoration === "restored" || row.restoration === "preserved_newer_contents" || row.restoration === "failed")) {
        replySeen = true;
        restoration = row.restoration;
      } else {
        restoration = "failed";
        release();
      }
    },
    close: (code) => {
      clearTimeout(prepareTimer);
      clearTimeout(leaseTimer);
      signal.removeEventListener("abort", release);
      ready(false);
      closed(code === 0 ? restoration : "failed");
    },
    fail: release,
  });
  const prepareTimer = setTimeout(release, 5000);
  const leaseTimer = setTimeout(release, 100_000);
  prepareTimer.unref();
  leaseTimer.unref();
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  if (!await prepared) { await finished; throw unavailable(); }
  return { finish: () => { release(); return finished; } };
}
