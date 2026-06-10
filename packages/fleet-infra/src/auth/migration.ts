import * as fs from "node:fs";
import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import { writeAtomicSync } from "../fs-store/atomic-write.js";
import { ensureSafeDirectory, SECURE_FILE_MODE } from "../fs-store/secure-fs.js";
import { readAuthStoreFile } from "./auth-store-file.js";
import type {
  AuthMigrationMergeResult,
  AuthMigrationResult,
  AuthStorageData,
} from "./types.js";

interface AuthMigrationOptions {
  readonly notify?: boolean;
  readonly legacyPath?: string;
  readonly currentPath?: string;
}

export const LEGACY_AUTH_PATH = path.join(getFleetDataDir(), "agent", "auth.json");
export const CURRENT_AUTH_PATH = path.join(getFleetDataDir(), "auth.json");

export function mergeAuthStoresNoOverwrite(
  legacy: AuthStorageData,
  current: AuthStorageData,
): AuthMigrationMergeResult {
  const data: AuthStorageData = { ...current };
  const migratedProviderIds: string[] = [];
  const skippedProviderIds: string[] = [];

  for (const [providerId, entry] of Object.entries(legacy)) {
    if (Object.prototype.hasOwnProperty.call(data, providerId)) {
      skippedProviderIds.push(providerId);
      continue;
    }

    data[providerId] = entry;
    migratedProviderIds.push(providerId);
  }

  return {
    data,
    migratedProviderIds,
    skippedProviderIds,
  };
}

export async function migrateLegacyAuthStore(
  options: AuthMigrationOptions = {},
): Promise<AuthMigrationResult> {
  const legacyPath = options.legacyPath ?? LEGACY_AUTH_PATH;
  const currentPath = options.currentPath ?? CURRENT_AUTH_PATH;

  if (!fs.existsSync(legacyPath)) {
    return createMigrationResult({
      legacyPath,
      currentPath,
      status: "legacy-missing",
      migratedProviderIds: [],
      skippedProviderIds: [],
      shouldPrintNotice: false,
    });
  }

  const legacy = readAuthStoreFile(legacyPath);
  const current = fs.existsSync(currentPath) ? readAuthStoreFile(currentPath) : {};
  const merged = mergeAuthStoresNoOverwrite(legacy, current);

  if (merged.migratedProviderIds.length > 0) {
    const dir = path.dirname(currentPath);
    ensureSafeDirectory(dir);
    writeAtomicSync(currentPath, `${JSON.stringify(merged.data, null, 2)}\n`, {
      mode: SECURE_FILE_MODE,
      fsync: true,
    });
  }

  return createMigrationResult({
    legacyPath,
    currentPath,
    status: merged.migratedProviderIds.length > 0 ? "migrated" : "unchanged",
    migratedProviderIds: merged.migratedProviderIds,
    skippedProviderIds: merged.skippedProviderIds,
    shouldPrintNotice: options.notify !== false && merged.migratedProviderIds.length > 0,
  });
}

function createMigrationResult(input: {
  legacyPath: string;
  currentPath: string;
  status: AuthMigrationResult["status"];
  migratedProviderIds: string[];
  skippedProviderIds: string[];
  shouldPrintNotice: boolean;
}): AuthMigrationResult {
  return {
    legacyPath: input.legacyPath,
    currentPath: input.currentPath,
    migratedCount: input.migratedProviderIds.length,
    skippedCount: input.skippedProviderIds.length,
    migratedProviderIds: input.migratedProviderIds,
    skippedProviderIds: input.skippedProviderIds,
    shouldPrintNotice: input.shouldPrintNotice,
    status: input.status,
  };
}
