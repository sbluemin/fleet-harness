interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersionGreater(left: string, right: string): boolean {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) {
    return false;
  }
  return compareVersions(leftVersion, rightVersion) > 0;
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
