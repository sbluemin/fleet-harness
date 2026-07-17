import fs from "node:fs";
import path from "node:path";

interface LastTargetFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number }): void;
  renameSync(oldPath: string, newPath: string): void;
}

export interface RemoteLastTargetStore {
  load(): string | null;
  save(target: string): void;
}

/** Stores only a successfully committed SSH target under Electron userData. */
export function createRemoteLastTargetStore(userDataPath: string, fileSystem: LastTargetFileSystem = fs): RemoteLastTargetStore {
  const statePath = path.join(userDataPath, "remote-runtime-last-target.json");
  const temporaryPath = `${statePath}.tmp`;
  return {
    load(): string | null {
      try {
        const parsed: unknown = JSON.parse(fileSystem.readFileSync(statePath, "utf8"));
        return isLastTargetState(parsed) ? parsed.sshTarget : null;
      } catch {
        return null;
      }
    },
    save(target): void {
      if (!isSshTarget(target)) return;
      try {
        fileSystem.mkdirSync(userDataPath, { recursive: true });
        fileSystem.writeFileSync(temporaryPath, `${JSON.stringify({ sshTarget: target })}\n`, { encoding: "utf8", mode: 0o600 });
        fileSystem.renameSync(temporaryPath, statePath);
      } catch {
        // Remembering a target is best-effort and must not interrupt pairing.
      }
    },
  };
}

function isLastTargetState(value: unknown): value is { sshTarget: string } {
  return typeof value === "object" && value !== null && "sshTarget" in value && isSshTarget(value.sshTarget);
}

function isSshTarget(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ssh:") && value.length > 4 && !/[\u0000-\u001f\u007f\s]/u.test(value);
}
