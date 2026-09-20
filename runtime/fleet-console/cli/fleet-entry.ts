import { createProviderAuthService } from "@fleet-console/ai-gateway";
import { getFleetDataDir } from "@fleet-console/infra";

import { createConsoleDataPaths } from "../core/host/bootstrap/paths.js";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { dispatchFleetArgv } from "./fleet-dispatch.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

const status = await dispatchFleetArgv(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  runApp,
  // 자격증명은 Console 슬롯에 산다. 옛 자리(Fleet 루트)는 승계 출처로만 넘긴다.
  createAuthService: () => createProviderAuthService({
    dataDir: createConsoleDataPaths().dir,
    legacyDirs: [getFleetDataDir()],
  }),
  dispatchAuthCommand,
  dispatchUpdateCommand,
  siblingCliPath: resolveSiblingConsoleCliPath(import.meta.url),
  moduleUrl: import.meta.url,
});

process.exitCode = status;
