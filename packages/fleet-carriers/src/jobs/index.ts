import * as abortSignals from "./abort-signals.js";
import * as archiveBlockConverter from "./archive-block-converter.js";
import * as archiveSerializer from "./archive-serializer.js";
import * as concurrencyGuard from "./concurrency-guard.js";
import * as detachedJobLifecycle from "./detached-job-lifecycle.js";
import * as dispatch from "./dispatch.js";
import * as jobCancelRegistry from "./job-cancel-registry.js";
import * as jobId from "./job-id.js";
import * as jobReminders from "./job-reminders.js";
import * as jobStreamArchive from "./job-stream-archive.js";
import * as jobTypes from "./job-types.js";
import * as lruCache from "./lru-cache.js";
import * as prompts from "./prompts.js";
import * as sanitize from "./sanitize.js";
import { buildCarrierJobsToolSpec } from "./tool-spec.js";
import * as types from "./types.js";
import {
  acquireJobPermit,
  getActiveBackgroundJobCount,
  onActiveJobCountChange,
  resetJobConcurrencyForTest,
} from "./concurrency-guard.js";
import { detachJobArchive } from "./job-stream-archive.js";
import { configureJobSummaryCache } from "./lru-cache.js";
import * as streamingEvents from "../stream/stream-events.js";
import {
  registerStreamHandler,
  unregisterStreamHandler,
} from "../stream/stream-events.js";

export * from "./abort-signals.js";
export * from "./archive-block-converter.js";
export * from "./archive-serializer.js";
export * from "./concurrency-guard.js";
export * from "./detached-job-lifecycle.js";
export * from "./dispatch.js";
export * from "./job-cancel-registry.js";
export * from "./job-id.js";
export * from "./job-reminders.js";
export * from "./job-stream-archive.js";
export * from "./job-types.js";
export * from "./lru-cache.js";
export * from "./prompts.js";
export * from "./sanitize.js";
export { buildCarrierJobsToolSpec } from "./tool-spec.js";
export * from "./types.js";

export const streaming = {
  ...streamingEvents,
  register: registerStreamHandler,
  unregister: unregisterStreamHandler,
};

export const carrierJobs = {
  abortSignals,
  archiveBlockConverter,
  archiveSerializer,
  concurrencyGuard,
  detachedJobLifecycle,
  dispatch,
  jobCancelRegistry,
  jobId,
  jobReminders,
  jobStreamArchive,
  jobTypes,
  lruCache,
  prompts,
  sanitize,
  types,
  configureJobSummaryCache,
  detachJobArchive,
  acquireJobPermit,
  buildToolSpec: buildCarrierJobsToolSpec,
  getActiveBackgroundJobCount,
  onActiveJobCountChange,
  resetJobConcurrencyForTest,
  streaming,
};
