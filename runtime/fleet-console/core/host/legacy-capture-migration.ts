import fs from "node:fs";
import path from "node:path";

import type { OperationStore } from "./operations/types.js";

const LEGACY_CAPTURES_DIR_NAME = "captures";

export interface MigrateLegacyCapturesDeps {
  readonly consoleDataDir: string;
  readonly operations: Pick<OperationStore, "get" | "patch">;
  readonly save?: () => void;
}

/**
 * One-shot best-effort migration: inject legacy captures/*.json into operation
 * payload.providerSession when missing, then delete the captures/ directory.
 * Failures never throw — boot must not be blocked.
 */
export function migrateLegacyCaptures(deps: MigrateLegacyCapturesDeps): void {
  try {
    migrateLegacyCapturesStrict(deps);
  } catch (error) {
    console.warn(`[fleet-console] Legacy capture migration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function migrateLegacyCapturesStrict(deps: MigrateLegacyCapturesDeps): void {
  const capturesDir = path.join(deps.consoleDataDir, LEGACY_CAPTURES_DIR_NAME);
  if (!fs.existsSync(capturesDir)) return;

  let migrated = false;
  try {
    const entries = fs.readdirSync(capturesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const operationId = entry.slice(0, -".json".length);
      if (!isSafeCaptureId(operationId)) continue;
      try {
        if (tryMigrateCaptureFile(deps, capturesDir, operationId, entry)) migrated = true;
      } catch (error) {
        console.warn(`[fleet-console] Legacy capture migrate failed for ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.warn(`[fleet-console] Legacy capture directory read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (migrated) {
    try {
      deps.save?.();
    } catch (error) {
      console.warn(`[fleet-console] Legacy capture migration save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    fs.rmSync(capturesDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[fleet-console] Legacy captures directory removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tryMigrateCaptureFile(
  deps: MigrateLegacyCapturesDeps,
  capturesDir: string,
  operationId: string,
  entry: string,
): boolean {
  const operation = deps.operations.get(operationId);
  if (!operation) return false;
  if (hasProviderSession(operation.payload)) return false;

  const filePath = path.join(capturesDir, entry);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const providerSession = sanitizeProviderSession(parsed);
  if (!providerSession) return false;

  deps.operations.patch(operationId, {
    payload: { ...operation.payload, providerSession },
  });
  return true;
}

function hasProviderSession(payload: Record<string, unknown> | undefined): boolean {
  return sanitizeProviderSession(payload?.providerSession) !== undefined;
}

function sanitizeProviderSession(value: unknown): {
  readonly provider: "claude" | "codex";
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly transcriptPath?: string;
  readonly source?: string;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as {
    readonly provider?: unknown;
    readonly sessionId?: unknown;
    readonly capturedAt?: unknown;
    readonly transcriptPath?: unknown;
    readonly source?: unknown;
  };
  if ((candidate.provider !== "claude" && candidate.provider !== "codex") || typeof candidate.sessionId !== "string" || typeof candidate.capturedAt !== "string") {
    return undefined;
  }
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    capturedAt: candidate.capturedAt,
    ...(typeof candidate.transcriptPath === "string" && candidate.transcriptPath.length > 0 ? { transcriptPath: candidate.transcriptPath } : {}),
    ...(typeof candidate.source === "string" && candidate.source.length > 0 ? { source: candidate.source } : {}),
  };
}

function isSafeCaptureId(value: string): boolean {
  return value.length > 0 && path.basename(value) === value && !value.includes(path.sep) && !value.includes(path.posix.sep);
}
