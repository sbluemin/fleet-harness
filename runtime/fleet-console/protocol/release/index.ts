// Console release contract: where a Fleet Console build is published on GitHub Releases,
// what its manifest says, and how a client decides whether to trust it. Pure and
// import-free on purpose — Console, Desktop, and release scripts all read the same file.

export const CONSOLE_RELEASE_REPOSITORY = { owner: "sbluemin", repo: "fleet-harness" } as const;
export const CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
export const CONSOLE_RELEASE_SCHEMA_VERSION = 1;
export const CONSOLE_RELEASE_MANIFEST_ASSET = "fleet-console-release.json";
export const CONSOLE_RELEASE_TARBALL_ALIAS = "fleet-console.tgz";
export const CONSOLE_RELEASE_CHECKSUMS_ASSET = "fleet-console-SHA256SUMS.txt";
/** Names an explicit release to follow instead of the repository's latest stable one. */
export const CONSOLE_RELEASE_TAG_OVERRIDE_ENV = "FLEET_CONSOLE_RELEASE_TAG";
export const CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX = "console-exp-";
export const MAX_CONSOLE_RELEASE_MANIFEST_BYTES = 64 * 1024;
export const MAX_CONSOLE_RELEASE_TARBALL_BYTES = 64 * 1024 * 1024;
/** Hosts a release download may pass through. Anything else is refused before a byte is read. */
export const CONSOLE_RELEASE_DOWNLOAD_HOSTS: readonly string[] = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
export const MAX_CONSOLE_RELEASE_REDIRECTS = 5;

export interface ConsoleReleaseTarball {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ConsoleReleaseManifest {
  readonly schema: typeof CONSOLE_RELEASE_SCHEMA_VERSION;
  readonly package: typeof CONSOLE_PACKAGE_NAME;
  readonly version: string;
  readonly tag: string;
  readonly tarball: ConsoleReleaseTarball;
  readonly engines?: { readonly node?: string };
}

export type ConsoleReleaseManifestRejection =
  | "not_object"
  | "schema_unsupported"
  | "package_mismatch"
  | "version_invalid"
  | "tag_mismatch"
  | "tarball_invalid"
  | "engines_invalid";

export type ConsoleReleaseManifestParseResult =
  | { readonly ok: true; readonly manifest: ConsoleReleaseManifest }
  | { readonly ok: false; readonly reason: ConsoleReleaseManifestRejection };

export type ConsoleReleaseTagOverride =
  | { readonly kind: "none" }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "invalid" };

const NUMERIC = "(?:0|[1-9]\\d{0,8})";
const STABLE_VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}$`);
const EXPERIMENT_VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}-exp\\.${NUMERIC}$`);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_ENGINE_RANGE_LENGTH = 128;

export function isStableConsoleVersion(version: string): boolean {
  return STABLE_VERSION.test(version);
}

export function isExperimentConsoleVersion(version: string): boolean {
  return EXPERIMENT_VERSION.test(version);
}

/** `v<stable>` for regular releases, `console-exp-<X.Y.Z-exp.N>` for experiment prereleases. */
export function consoleReleaseTagForVersion(version: string): string | null {
  if (isStableConsoleVersion(version)) return `v${version}`;
  if (isExperimentConsoleVersion(version)) return `${CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX}${version}`;
  return null;
}

/** The only version a tag may carry. Returns null for anything that is not a Console release tag. */
export function consoleVersionFromReleaseTag(tag: string): string | null {
  if (tag.startsWith("v")) {
    const version = tag.slice(1);
    return isStableConsoleVersion(version) ? version : null;
  }
  if (tag.startsWith(CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX)) {
    const version = tag.slice(CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX.length);
    return isExperimentConsoleVersion(version) ? version : null;
  }
  return null;
}

export function isConsoleReleaseTag(tag: string): boolean {
  return consoleVersionFromReleaseTag(tag) !== null;
}

/** Reads the override from a caller-supplied environment. Set-but-malformed is reported, never ignored. */
export function readConsoleReleaseTagOverride(env: Readonly<Record<string, string | undefined>>): ConsoleReleaseTagOverride {
  const raw = env[CONSOLE_RELEASE_TAG_OVERRIDE_ENV];
  if (raw === undefined || raw.trim() === "") return { kind: "none" };
  const tag = raw.trim();
  return isConsoleReleaseTag(tag) ? { kind: "tag", tag } : { kind: "invalid" };
}

export function consoleTarballName(version: string): string {
  return `fleet-console-${version}.tgz`;
}

export function consoleReleaseAssetUrl(tag: string, name: string): string {
  const { owner, repo } = CONSOLE_RELEASE_REPOSITORY;
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** Without a tag this follows GitHub's latest release, which by definition excludes drafts and prereleases. */
export function consoleReleaseLatestAssetUrl(name: string): string {
  const { owner, repo } = CONSOLE_RELEASE_REPOSITORY;
  return `https://github.com/${owner}/${repo}/releases/latest/download/${encodeURIComponent(name)}`;
}

export function consoleReleaseManifestUrl(tag?: string): string {
  return tag === undefined ? consoleReleaseLatestAssetUrl(CONSOLE_RELEASE_MANIFEST_ASSET) : consoleReleaseAssetUrl(tag, CONSOLE_RELEASE_MANIFEST_ASSET);
}

/** The tarball URL is always derived from the verified manifest, never read from it. */
export function consoleReleaseTarballUrl(manifest: Pick<ConsoleReleaseManifest, "tag" | "tarball">): string {
  return consoleReleaseAssetUrl(manifest.tag, manifest.tarball.name);
}

export function isAllowedConsoleReleaseDownloadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && CONSOLE_RELEASE_DOWNLOAD_HOSTS.includes(parsed.hostname);
}

/**
 * Validates an untrusted manifest. Without `tag` the manifest must describe a stable `v<version>`
 * release; with `tag` it must describe exactly that release, whose version the tag itself fixes.
 */
export function parseConsoleReleaseManifest(value: unknown, options: { readonly tag?: string } = {}): ConsoleReleaseManifestParseResult {
  if (!isRecord(value)) return reject("not_object");
  if (value.schema !== CONSOLE_RELEASE_SCHEMA_VERSION) return reject("schema_unsupported");
  if (value.package !== CONSOLE_PACKAGE_NAME) return reject("package_mismatch");
  const { version, tag } = value;
  if (typeof version !== "string") return reject("version_invalid");
  if (options.tag === undefined) {
    if (!isStableConsoleVersion(version)) return reject("version_invalid");
    if (tag !== `v${version}`) return reject("tag_mismatch");
  } else {
    const expectedVersion = consoleVersionFromReleaseTag(options.tag);
    if (expectedVersion === null || tag !== options.tag) return reject("tag_mismatch");
    if (version !== expectedVersion) return reject("version_invalid");
  }
  const tarball = parseTarball(value.tarball, version);
  if (tarball === null) return reject("tarball_invalid");
  const engines = parseEngines(value.engines);
  if (engines === false) return reject("engines_invalid");
  return {
    ok: true,
    manifest: {
      schema: CONSOLE_RELEASE_SCHEMA_VERSION,
      package: CONSOLE_PACKAGE_NAME,
      version,
      tag: tag as string,
      tarball,
      ...(engines === undefined ? {} : { engines }),
    },
  };
}

function parseTarball(value: unknown, version: string): ConsoleReleaseTarball | null {
  if (!isRecord(value)) return null;
  const { name, size, sha256 } = value;
  if (name !== consoleTarballName(version)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_CONSOLE_RELEASE_TARBALL_BYTES) return null;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return null;
  return { name, size, sha256 };
}

function parseEngines(value: unknown): { readonly node?: string } | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  if (value.node === undefined) return {};
  if (typeof value.node !== "string" || value.node.length === 0 || value.node.length > MAX_ENGINE_RANGE_LENGTH) return false;
  return { node: value.node };
}

function reject(reason: ConsoleReleaseManifestRejection): ConsoleReleaseManifestParseResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
