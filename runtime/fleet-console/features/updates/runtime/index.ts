export type {
  UpdateChannel,
} from "./version-check.js";
export type {
  CreateGlobalPackageUpdaterDeps,
  GlobalPackageBinaryResolver,
  GlobalPackageCanWrite,
  GlobalPackageCurrentVersionResolver,
  GlobalPackageExecFile,
  GlobalPackageInstallContext,
  GlobalPackageInstallProcess,
  GlobalPackageManagerCommand,
  GlobalPackageManagerDetection,
  GlobalPackageManagerInstall,
  GlobalPackageRealpath,
  GlobalPackageRootResolver,
  GlobalPackageSpawnContext,
  GlobalPackageSpawnInstall,
  GlobalPackageUpdateOptions,
  GlobalPackageUpdateReason,
  GlobalPackageUpdateResult,
  GlobalPackageUpdateStatus,
  GlobalPackageUpdater,
  GlobalPackageUpdaterHook,
  GlobalPackageUpdaterReport,
  GlobalPackageVersionResolver,
} from "./global-package-updater.js";
export {
  fetchLatestVersion,
  isVersionGreater,
} from "./version-check.js";
export {
  createGlobalPackageUpdater,
} from "./global-package-updater.js";
