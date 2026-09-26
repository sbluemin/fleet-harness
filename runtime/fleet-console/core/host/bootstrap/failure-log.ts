import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_FIELD_CHARS = 16 * 1024;

/** Synchronous diagnostics also work when a detached daemon has no stdio or an exception is fatal. */
export function createConsoleFailureLog(directory: string): (kind: string, error: unknown) => void {
  const file = path.join(directory, "errors.jsonl");
  return (kind, error) => {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack ?? null : null;
      const line = `${JSON.stringify({ ts: new Date().toISOString(), kind, message: message.slice(0, MAX_FIELD_CHARS), stack: stack?.slice(0, MAX_FIELD_CHARS) ?? null })}\n`;
      try { process.stderr.write(line); } catch { /* Detached daemons have no stderr. */ }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(file).size + Buffer.byteLength(line) > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
    } catch {
      // Diagnostic failure must not replace the original failure or block startup.
    }
  };
}
