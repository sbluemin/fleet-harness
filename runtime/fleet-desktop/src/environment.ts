import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV, resolveCanonicalLocalConsolePaths, resolveCanonicalStableConsolePaths } from "@dotobokuri/fleet-console/desktop-protocol";

export interface DesktopEnvironment {
  readonly ownerId: string;
  readonly consoleDir: string;
  readonly dataDir: string;
  readonly serviceEnv: NodeJS.ProcessEnv;
}

const DESKTOP_CONTROL_ENV_KEYS = new Set([
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  "FLEET_CONSOLE_DESKTOP_VERSION",
  "FLEET_CONSOLE_DIR",
]);

export function resolveDesktopUserDataDirectory(userDataDir: string, resourceRoot: string, isPackaged: boolean): string {
  return isPackaged ? userDataDir : path.join(resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot }).dir, "desktop");
}

export function createDesktopEnvironment(userDataDir: string, appVersion: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): DesktopEnvironment {
  const overrideDirectory = isPackaged ? readEnvironmentValue(env, "FLEET_CONSOLE_DIR") : undefined;
  if (overrideDirectory !== undefined && !path.isAbsolute(overrideDirectory)) throw new Error("desktop_console_dir_must_be_absolute");
  const paths = isPackaged
    ? resolveCanonicalStableConsolePaths({ tmpDir: os.tmpdir(), uid: typeof process.getuid === "function" ? process.getuid() : 0, fleetDataDir: path.join(os.homedir(), ".fleet"), consoleDirOverride: overrideDirectory })
    : resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot });
  const ownerDirectory = isPackaged ? userDataDir : paths.dir;
  const ownerFile = path.join(ownerDirectory, "desktop-owner-id");
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  const ownerId = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, "utf8").trim() : crypto.randomUUID();
  if (!fs.existsSync(ownerFile)) fs.writeFileSync(ownerFile, `${ownerId}\n`, { mode: 0o600 });
  return {
    ownerId,
    consoleDir: paths.dir,
    dataDir: paths.dataDir,
    serviceEnv: {
      ...sanitizeEnvironment(env),
      [DESKTOP_OWNER_ID_ENV]: ownerId,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
      [DESKTOP_RESOURCE_ROOT_ENV]: resourceRoot,
      ...(isPackaged ? {} : { [DESKTOP_DEVELOPMENT_ENV]: "1" }),
      ...(isPackaged ? (overrideDirectory === undefined ? {} : { FLEET_CONSOLE_DIR: paths.dir }) : { FLEET_CONSOLE_DIR: paths.dir }),
      FLEET_CONSOLE_DESKTOP_VERSION: appVersion,
    },
  };
}

export function sanitizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (value !== undefined && normalizedKey !== "NODE_OPTIONS" && !normalizedKey.startsWith("ELECTRON_") && !DESKTOP_CONTROL_ENV_KEYS.has(normalizedKey)) next[key] = value;
  }
  return next;
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalizedName)?.[1];
}
