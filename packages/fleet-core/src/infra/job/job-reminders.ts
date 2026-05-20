import type { CarrierJobStatus, CarrierJobSummary } from "./job-types.js";

interface SystemReminderAttributes {
  [key: string]: string;
}

export interface CarrierResultSystemReminderInput {
  jobId: string;
  kind: "carrier" | "taskforce";
  status: CarrierJobStatus;
  summary: CarrierJobSummary;
  error?: string;
  taskforceBackend?: string;
  label?: string;
}

export const JOB_LAUNCH_NOTICE = [
  "Job accepted; result arrives later via carrier-completion follow-up push tagged [carrier:result].",
  "DO NOT poll carrier_jobs.",
].join(" ");

export const CARRIER_RESULT_PUSH_PREFIX = "[carrier:result]";

export function formatLaunchResponseText(response: unknown, accepted: boolean): string {
  const payload = JSON.stringify(response);
  if (!accepted) return payload;
  return JOB_LAUNCH_NOTICE + "\n" + payload;
}

export function buildCarrierResultSystemReminder(input: CarrierResultSystemReminderInput): string {
  const lines = [`- ${input.jobId}: ${sanitizeReminderSummary(input.summary.summary)}`];
  const metadata = [
    `kind=${input.kind}`,
    `status=${input.status}`,
    input.label ? `label=${input.label}` : undefined,
    input.taskforceBackend ? `backend=${input.taskforceBackend}` : undefined,
    input.error ? `error=${sanitizeReminderSummary(input.error)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  if (metadata.length > 0) lines.push(`  ${metadata.join(" ")}`);
  return wrapSystemReminder(`${CARRIER_RESULT_PUSH_PREFIX}\n${lines.join("\n")}`, { source: "carrier-completion" });
}

export function wrapSystemReminder(text: string, attrs?: SystemReminderAttributes): string {
  const renderedAttrs = renderSystemReminderAttributes(attrs);
  return `<system-reminder${renderedAttrs}>\n${text}\n</system-reminder>`;
}

function sanitizeReminderSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, 500);
}

function renderSystemReminderAttributes(attrs?: SystemReminderAttributes): string {
  if (!attrs) return "";
  const pairs = Object.entries(attrs);
  if (pairs.length === 0) return "";
  return pairs.map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`).join("");
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
