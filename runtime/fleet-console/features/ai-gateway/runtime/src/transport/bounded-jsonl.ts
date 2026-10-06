import {
  appendFile,
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export interface BoundedJsonlWriterOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

export interface BoundedJsonlWriter {
  write(record: unknown): void;
  flush(): Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/**
 * An append-only bounded JSONL writer.
 *
 * Writes are serialized behind a promise chain to avoid interleaved lines.
 * If the file exceeds `maxBytes`, it is rotated to `${filePath}.1`.
 * Deliberately fail-open: writer errors are swallowed so diagnostic logging
 * never interferes with application execution.
 */
export function createBoundedJsonlWriter(options: BoundedJsonlWriterOptions): BoundedJsonlWriter {
  const { filePath, maxBytes } = options;
  const backupPath = `${filePath}.1`;
  const dir = path.dirname(filePath);

  let initialized = false;
  let currentBytes = 0;
  let pending = Promise.resolve();

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const file = await stat(filePath);
      currentBytes = file.size;
      await chmod(filePath, 0o600).catch(() => undefined);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      currentBytes = 0;
    }
    initialized = true;
  };

  const rotate = async (): Promise<void> => {
    await ignoreMissing(unlink(backupPath));
    try {
      await rename(filePath, backupPath);
      await chmod(backupPath, 0o600).catch(() => undefined);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    currentBytes = 0;
  };

  const append = async (line: string): Promise<void> => {
    await initialize();
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) return;
    if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
      await rotate();
    }
    await appendFile(filePath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    currentBytes += bytes;
  };

  return {
    write: (record: unknown) => {
      let line: string;
      try {
        line = `${JSON.stringify(record)}\n`;
      } catch {
        return;
      }
      pending = pending.then(() => append(line)).catch(() => undefined);
    },
    flush: () => pending,
  };
}
