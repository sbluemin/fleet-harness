import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export const LEGACY_AUTH_PATH = path.join(os.homedir(), ".fleet", "agent", "auth.json");
export const CURRENT_AUTH_PATH = path.join(os.homedir(), ".fleet", "auth.json");

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

  const legacy = readAuthStore(legacyPath);
  const current = fs.existsSync(currentPath) ? readAuthStore(currentPath) : {};
  const merged = mergeAuthStoresNoOverwrite(legacy, current);

  if (merged.migratedProviderIds.length > 0) {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, JSON.stringify(merged.data, null, 2));
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

function readAuthStore(filePath: string): AuthStorageData {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AuthStorageData;
}
