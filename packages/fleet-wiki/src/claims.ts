import { mkdir } from "node:fs/promises";
import path from "node:path";

import { findUnsafeMemoryText } from "./store.js";
import { assertSafeEntryId, listFileNames, pathExists, readJsonFile, writeJsonFile } from "./store.js";
import type {
  Claim,
  ClaimConfidence,
  ClaimSet,
  ClaimSourceRef,
  ClaimSourceSpan,
  MemoryPaths,
} from "./types.js";

const CLAIMS_DIRNAME = ".claims";
const CLAIM_CONFIDENCES: ClaimConfidence[] = ["low", "medium", "high"];

export async function readClaims(entryId: string, paths: MemoryPaths): Promise<ClaimSet | null> {
  assertSafeEntryId(entryId);
  const claimsFile = getClaimsFile(paths, entryId);
  if (!(await pathExists(claimsFile))) {
    return null;
  }
  try {
    return validateClaimSet(await readJsonFile<unknown>(claimsFile), entryId);
  } catch (error) {
    throw new Error(`[fleet-wiki] malformed claims sidecar: ${entryId} (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function writeClaims(claimSet: ClaimSet, paths: MemoryPaths): Promise<void> {
  const normalized = validateClaimSet(claimSet, claimSet.entryId);
  await mkdir(getClaimsDir(paths), { recursive: true });
  await writeJsonFile(getClaimsFile(paths, claimSet.entryId), normalized satisfies ClaimSet, paths);
}

export async function listClaims(paths: MemoryPaths): Promise<ClaimSet[]> {
  const claimsDir = getClaimsDir(paths);
  const claimSets: ClaimSet[] = [];
  for (const fileName of await listFileNames(claimsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const entryId = path.basename(fileName, ".json");
    const claimSet = await readClaims(entryId, paths);
    if (claimSet) {
      claimSets.push(claimSet);
    }
  }
  return claimSets.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function getClaimsDir(paths: MemoryPaths): string {
  return path.join(paths.wikiDir, CLAIMS_DIRNAME);
}

export function getClaimsFile(paths: MemoryPaths, entryId: string): string {
  assertSafeEntryId(entryId);
  const claimsFile = path.join(getClaimsDir(paths), `${entryId}.json`);
  const relative = path.relative(getClaimsDir(paths), claimsFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[fleet-wiki] claims sidecar escapes wiki/.claims: ${entryId}`);
  }
  return claimsFile;
}

export function validateClaimSet(value: unknown, expectedEntryId?: string): ClaimSet {
  if (!value || typeof value !== "object") {
    throw new Error("claims sidecar must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.entryId !== "string" || candidate.entryId.trim().length === 0) {
    throw new Error("claims sidecar entryId must be a non-empty string");
  }
  assertSafeEntryId(candidate.entryId);
  if (expectedEntryId && candidate.entryId !== expectedEntryId) {
    throw new Error(`claims sidecar entryId mismatch: expected ${expectedEntryId}, got ${candidate.entryId}`);
  }
  if (!Array.isArray(candidate.claims)) {
    throw new Error("claims sidecar claims must be an array");
  }
  return {
    entryId: candidate.entryId,
    claims: candidate.claims.map((claim) => validateClaim(claim)),
  };
}

function validateClaim(value: unknown): Claim {
  if (!value || typeof value !== "object") {
    throw new Error("claim must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw new Error("claim id must be a non-empty string");
  }
  assertSafeEntryId(candidate.id);
  if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
    throw new Error("claim text must be a non-empty string");
  }
  ensureSafeClaimText(candidate.text, "claim text");
  if (!Array.isArray(candidate.sourceRefs)) {
    throw new Error("claim sourceRefs must be an array");
  }
  if (!CLAIM_CONFIDENCES.includes(candidate.confidence as ClaimConfidence)) {
    throw new Error(`invalid claim confidence: ${String(candidate.confidence)}`);
  }
  return {
    id: candidate.id,
    text: candidate.text.trim(),
    sourceRefs: candidate.sourceRefs.map((sourceRef) => validateClaimSourceRef(sourceRef)),
    confidence: candidate.confidence as ClaimConfidence,
  };
}

function validateClaimSourceRef(value: unknown): ClaimSourceRef {
  if (!value || typeof value !== "object") {
    throw new Error("claim sourceRef must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ref !== "string" || candidate.ref.trim().length === 0) {
    throw new Error("claim sourceRef ref must be a non-empty string");
  }
  assertSafeClaimRawRef(candidate.ref);
  const quote = typeof candidate.quote === "string" ? candidate.quote : undefined;
  if (quote) {
    ensureSafeClaimText(quote, "claim quote");
  }
  const span = candidate.span === undefined ? undefined : validateClaimSourceSpan(candidate.span);
  return {
    ref: candidate.ref,
    quote,
    span,
  };
}

function validateClaimSourceSpan(value: unknown): ClaimSourceSpan {
  if (!value || typeof value !== "object") {
    throw new Error("claim sourceRef span must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.start) || !Number.isInteger(candidate.end)) {
    throw new Error("claim sourceRef span start/end must be integers");
  }
  if ((candidate.start as number) < 0 || (candidate.end as number) < 0 || (candidate.start as number) > (candidate.end as number)) {
    throw new Error("claim sourceRef span range is invalid");
  }
  return {
    start: candidate.start as number,
    end: candidate.end as number,
  };
}

function assertSafeClaimRawRef(ref: string): void {
  if (!ref.startsWith("raw/")) {
    throw new Error(`claim sourceRef must point into raw/: ${ref}`);
  }
  if (ref.includes("..") || path.isAbsolute(ref)) {
    throw new Error(`claim sourceRef escapes raw/: ${ref}`);
  }
}

function ensureSafeClaimText(value: string, field: string): void {
  const unsafe = findUnsafeMemoryText(value);
  if (unsafe.length > 0) {
    throw new Error(`${field} contains unsafe text`);
  }
}
