import * as agent from "./agent/index.js";
import { auth } from "./auth/index.js";
import { dataDir } from "./data-dir/index.js";
import { job } from "./job/index.js";
import { log } from "./log/index.js";
import { settings } from "./settings/index.js";
import { createSessionRuntime, type SessionRuntime } from "./agent/index.js";
import { createJobCancelRegistry, type JobCancelRegistry } from "./job/job-cancel-registry.js";
import { createJobStreamArchiveStore, type JobStreamArchiveStore } from "./job/job-stream-archive.js";
import { createJobSummaryCache, type JobSummaryCache } from "./job/lru-cache.js";
import { createCoreLogStore, type CoreLogStore } from "./log/store.js";

export interface InfraServices {
  agent: typeof agent;
  auth: typeof auth;
  dataDir: typeof dataDir;
  job: typeof job;
  log: typeof log;
  settings: typeof settings;
  sessionRuntime: SessionRuntime;
  jobCancelRegistry: JobCancelRegistry;
  jobStreamArchive: JobStreamArchiveStore;
  jobSummaryCache: JobSummaryCache;
  coreLogStore: CoreLogStore;
}

export interface InfraServicesDeps {
  readonly config?: Record<string, never>;
}

export * from "./agent/index.js";
export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./settings/index.js";
export * from "./log/index.js";
export * from "./job/index.js";

export const infra = {
  agent,
  auth,
  dataDir,
  job,
  log,
  settings,
};

export function createInfraServices(_deps: InfraServicesDeps = {}): InfraServices {
  return {
    agent,
    auth,
    dataDir,
    job,
    log,
    settings,
    sessionRuntime: createSessionRuntime(),
    jobCancelRegistry: createJobCancelRegistry(),
    jobStreamArchive: createJobStreamArchiveStore(),
    jobSummaryCache: createJobSummaryCache(),
    coreLogStore: createCoreLogStore(),
  };
}
