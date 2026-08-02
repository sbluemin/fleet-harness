import fs from "node:fs";
import path from "node:path";

import type { OperationNode, OperationStore } from "./operations/operations-domain.js";

const LEGACY_CAPTURES_DIR_NAME = "captures";

export interface MigrateLegacyCapturesDeps {
  readonly consoleDataDir: string;
  readonly operations: Pick<OperationStore, "get" | "patch">;
  readonly save?: () => void;
  /** 삭제 유예(tombstone) 중인 Operation — live store에 없으므로 별도 전달한다. */
  readonly tombstonedOperations?: readonly OperationNode[];
}

type CaptureFileOutcome = {
  /** live store payload에 실제로 이관했음 */
  readonly migrated: boolean;
  /** tombstone Operation이 Analyst용 capture를 아직 필요로 해 파일을 남겨야 함 */
  readonly retained: boolean;
};

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
  if (!path.isAbsolute(deps.consoleDataDir)) return;
  const capturesDir = path.join(deps.consoleDataDir, LEGACY_CAPTURES_DIR_NAME);
  if (!fs.existsSync(capturesDir)) return;

  let migrated = false;
  let retained = false;
  try {
    const entries = fs.readdirSync(capturesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const operationId = entry.slice(0, -".json".length);
      if (!isSafeCaptureId(operationId)) continue;
      try {
        const outcome = processCaptureFile(deps, capturesDir, operationId, entry);
        if (outcome.migrated) migrated = true;
        if (outcome.retained) retained = true;
      } catch (error) {
        // 일시적 읽기 오류나 손상 JSON으로 실패한 파일은 유일한 legacy 매핑일 수 있으므로
        // 다른 파일의 이관 성공에 휩쓸려 삭제되지 않도록 보존하고 다음 부팅에 재시도한다.
        retained = true;
        console.warn(`[fleet-console] Legacy capture migrate failed for ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    // 목록 조회 자체가 실패하면 어떤 파일도 검사하지 못한 것이므로, 통째로 지우는 대신
    // 보존하고 다음 부팅에 재시도한다.
    retained = true;
    console.warn(`[fleet-console] Legacy capture directory read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let saved = false;
  if (migrated) {
    try {
      deps.save?.();
      saved = true;
    } catch (error) {
      console.warn(`[fleet-console] Legacy capture migration save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // save 실패(이관분은 디스크에 없음) 또는 tombstone 보존이 필요하면 captures/를 남긴다.
  // 둘 중 하나라도 보존을 요구하면 디렉토리를 삭제하지 않는다.
  if ((!migrated || saved) && !retained) {
    try {
      fs.rmSync(capturesDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[fleet-console] Legacy captures directory removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function processCaptureFile(
  deps: MigrateLegacyCapturesDeps,
  capturesDir: string,
  operationId: string,
  entry: string,
): CaptureFileOutcome {
  const operation = deps.operations.get(operationId);
  if (operation) {
    if (hasProviderSession(operation.payload)) return { migrated: false, retained: false };

    const filePath = path.join(capturesDir, entry);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const providerSession = sanitizeProviderSession(parsed);
    if (!providerSession) return { migrated: false, retained: false };

    deps.operations.patch(operationId, {
      payload: { ...operation.payload, providerSession },
    });
    return { migrated: true, retained: false };
  }

  // live store에 없으면 삭제 유예 tombstone을 본다 — tombstone payload는 수정하지 않고,
  // Analyst transcript용 capture만 다음 부팅까지 보존한다.
  const tombstoned = deps.tombstonedOperations?.find((candidate) => candidate.id === operationId);
  if (tombstoned && !hasProviderSession(tombstoned.payload)) {
    return { migrated: false, retained: true };
  }
  return { migrated: false, retained: false };
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
