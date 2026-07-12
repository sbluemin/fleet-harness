import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ZOOM_LEVEL = 0;
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 3;

interface ZoomStateFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  renameSync(oldPath: string, newPath: string): void;
}

export interface ZoomState {
  load(): number;
  save(zoomLevel: number): void;
}

export function clampZoomLevel(zoomLevel: number): number {
  if (!Number.isFinite(zoomLevel)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, zoomLevel));
}

export function createZoomState(statePath: string, fileSystem: ZoomStateFileSystem = fs): ZoomState {
  const temporaryPath = `${statePath}.tmp`;
  return {
    load(): number {
      try {
        const parsed: unknown = JSON.parse(fileSystem.readFileSync(statePath, "utf8"));
        if (!isZoomState(parsed)) return DEFAULT_ZOOM_LEVEL;
        return clampZoomLevel(parsed.zoomLevel);
      } catch {
        return DEFAULT_ZOOM_LEVEL;
      }
    },
    save(zoomLevel: number): void {
      try {
        fileSystem.mkdirSync(path.dirname(statePath), { recursive: true });
        fileSystem.writeFileSync(temporaryPath, `${JSON.stringify({ zoomLevel: clampZoomLevel(zoomLevel) })}\n`, "utf8");
        fileSystem.renameSync(temporaryPath, statePath);
      } catch {
        // Zoom persistence is best-effort; a read-only userData directory must not interrupt the Console.
      }
    },
  };
}

function isZoomState(value: unknown): value is { zoomLevel: number } {
  return typeof value === "object" && value !== null && "zoomLevel" in value && typeof value.zoomLevel === "number";
}
