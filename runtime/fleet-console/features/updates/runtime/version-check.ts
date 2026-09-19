export type UpdateChannel = "latest";

interface NpmPackageMetadata {
  readonly "dist-tags"?: Record<string, string | undefined>;
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly string[];
}

const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org/";
const REGISTRY_TIMEOUT_MS = 3_000;
const MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export async function fetchLatestVersion(packageName: string, channel?: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(`${NPM_REGISTRY_BASE_URL}${encodeNpmPackageName(packageName)}`, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const metadata = await readJsonWithByteLimit(response, controller);
    if (metadata === undefined) {
      return undefined;
    }
    const latest = metadata["dist-tags"]?.[channel ?? "latest"];
    return typeof latest === "string" && latest.length > 0 ? latest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function isVersionGreater(left: string, right: string): boolean {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) {
    return false;
  }
  return compareVersions(leftVersion, rightVersion) > 0;
}

function encodeNpmPackageName(packageName: string): string {
  if (!packageName.startsWith("@")) {
    return encodeURIComponent(packageName);
  }
  const separatorIndex = packageName.indexOf("/");
  if (separatorIndex === -1) {
    return encodeURIComponent(packageName);
  }
  const scope = packageName.slice(1, separatorIndex);
  const name = packageName.slice(separatorIndex + 1);
  return `@${encodeURIComponent(scope)}%2f${encodeURIComponent(name)}`;
}

async function readJsonWithByteLimit(response: Response, controller: AbortController): Promise<NpmPackageMetadata | undefined> {
  const body = response.body;
  if (body === null) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REGISTRY_RESPONSE_BYTES) {
        controller.abort();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(joinChunks(chunks, totalBytes))) as NpmPackageMetadata;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4]?.split(".") ?? [],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const base = compareNumbers(left.major, right.major) || compareNumbers(left.minor, right.minor) || compareNumbers(left.patch, right.patch);
  if (base !== 0) {
    return base;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return compareNumbers(right.pre.length, left.pre.length);
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const leftPart = left.pre[index];
    const rightPart = right.pre[index];
    if (leftPart === undefined || rightPart === undefined) {
      return compareNumbers(left.pre.length, right.pre.length);
    }
    const compared = comparePrereleasePart(leftPart, rightPart);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = parseNumericPart(left);
  const rightNumber = parseNumericPart(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return compareNumbers(leftNumber, rightNumber);
  }
  if (leftNumber !== undefined) {
    return -1;
  }
  if (rightNumber !== undefined) {
    return 1;
  }
  return left.localeCompare(right);
}

function parseNumericPart(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left > right ? 1 : -1;
}
