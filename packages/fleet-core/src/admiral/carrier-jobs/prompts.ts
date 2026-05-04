import { Type, type TObject } from "@sinclair/typebox";

export const CARRIER_JOBS_DOCTRINE = {
  id: "carrier_jobs",
  tag: "carrier_jobs",
  title: "carrier_jobs Tool Guidelines",
  description:
    `Lookup and control detached carrier jobs registered by individual carrier tools (carrier_<id>), carrier_squadron, and carrier_taskforce.` +
    ` This is not a delegation tool and not a polling tool; use it only to inspect archived output, cancel by job_id, or list jobs.`,
  promptSnippet:
    `carrier_jobs — Lookup/control detached carrier jobs: status, result, cancel, list.`,
  whenToUse: [
    `Use carrier_jobs when a follow-up push is missing, explicit job inspection is required, or the Admiral needs completion metadata, full archived output, cancellation, or a job list.`,
    `Use action:"result" only after the job is finalized; full results remain repeatable for 3 hours.`,
  ],
  whenNotToUse: [
    `Do not use carrier_jobs to delegate new work; use individual carrier tools (carrier_<id>), carrier_squadron, or carrier_taskforce.`,
    `Do not request results for active jobs. Results are finalized-only, read-many for 3 hours, and expire by TTL.`,
    `Do not poll, wait-check, or call carrier_jobs merely to see whether a launched job is done; terminal results arrive through the [carrier:result] follow-up push.`,
  ],
  usageGuidelines: [
    `carrier_jobs has exactly four actions: status, result, cancel, list.`,
    `After launch, continue independent work if available; otherwise stop tool use and wait passively for the follow-up push instead of issuing status probes.`,
    `Treat carrier_jobs as the fallback channel for missing pushes or explicit lookups, not as a polling loop.`,
    `Results are finalized-only, read-many for 3h in process memory.`,
    `carrier_jobs reads the process-memory summary cache and JobStreamArchive only. It never reads the Agent Panel stream-store.`,
  ],
};

export function buildCarrierJobsSchema(): TObject {
  return Type.Object({
    action: Type.Unsafe<string>({
      type: "string",
      enum: ["status", "result", "cancel", "list"],
      description: "Job action to perform.",
    }),
    job_id: Type.Optional(Type.String({
      description: "Required for status, result, and cancel. Must be a prefixed job ID such as sortie:<toolCallId>.",
    })),
    format: Type.Optional(Type.Unsafe<string>({
      type: "string",
      enum: ["summary", "full"],
      description: "Optional result detail level for renderers and result lookups.",
    })),
  });
}
