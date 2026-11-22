export const SCHEMA_VERSION: 1;
export const BUNDLE_ID: "com.dotobokuri.fleet-console";
export const DEV_BUNDLE_ID: "com.dotobokuri.fleet-console.dev";
export const PRODUCT_NAME: "Fleet Console";
export const IDENTITY_FILE_NAME: string;
export const PLIST_IDENTITY_KEY: string;
export const ARCHIVE_NAME: string;
export const RELEASE_CHECK_ENV: "FLEET_CONSOLE_RELEASE_TAG";
export const RELEASE_CHECK_VALUE: "source";
export const EXECUTABLE_RELATIVE_PATH: string;
export const APP_IDENTITY_RELATIVE_PATH: string;
export const CONSOLE_CLI_RELATIVE_PATH: string;
export const CONSOLE_IDENTITY_RELATIVE_PATH: string;
export const RUNTIME_LATEST_RELATIVE_TO_HOME: string;
export const DESKTOP_RESOURCE_ROOT_MARKER: string;
export const DESKTOP_RESOURCE_ROOT_MARKER_CONTENT: string;

interface PackageArchive {
  sourceRevision: string;
  sourceDirty: boolean;
  archivePath: string;
  archiveSha256: string;
}

export function assertSourceRevision(sourceRevision: string): void;
export function identityDocument(sourceRevision: string): {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "fleet-remote-mac-package";
  sourceRevision: string;
  bundleId: typeof BUNDLE_ID;
  productName: typeof PRODUCT_NAME;
};
export function assertReleaseBundleIdentifier(bundleId: string): void;
export function stampInfoPlist(xml: string, sourceRevision: string): string;
export function assertPackagedAppPath(appPath: string, releaseDirectory: string): string;
export function remoteMacManifest(input: PackageArchive): PackageArchive & {
  schemaVersion: typeof SCHEMA_VERSION;
  format: "zip";
  bundleId: typeof BUNDLE_ID;
  executableRelativePath: string;
  appIdentityRelativePath: string;
  plistIdentityKey: string;
  consoleCliRelativePath: string;
  consoleIdentityRelativePath: string;
  runtimeLatestRelativeToHome: string;
  releaseCheckEnv: { name: typeof RELEASE_CHECK_ENV; value: typeof RELEASE_CHECK_VALUE };
};
export function readSourceRevision(repoRoot: string): Promise<Pick<PackageArchive, "sourceRevision" | "sourceDirty">>;
