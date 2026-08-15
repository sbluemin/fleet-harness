import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setWireLogTarget } from "../../src/transport/wire-log.js";

export interface WireLogFixture {
  readonly path: string;
  read(): Array<Record<string, unknown>>;
  cleanup(): void;
}

export function wireLogFixture(prefix: string): WireLogFixture {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  const filePath = path.join(directory, "wire-log.jsonl");
  setWireLogTarget({ path: filePath });
  return {
    path: filePath,
    read() {
      return readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    cleanup() {
      setWireLogTarget(undefined);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
