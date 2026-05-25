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
  "Job accepted from carrier_dispatch; result arrives later via carrier-completion follow-up push tagged [carrier:result].",
  "Task Force is an execution mode of carrier_dispatch when the selected carrier is configured for it.",
  "DO NOT poll carrier_jobs.",
].join(" ");

export const CARRIER_RESULT_PUSH_PREFIX = "[carrier:result]";

const REMINDER_TEXT_LIMIT = 500;
const REMINDER_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const REMINDER_WHITESPACE = /\s+/g;

export function formatLaunchResponseText(response: unknown, accepted: boolean): string {
  const payload = JSON.stringify(response);
  if (!accepted) return payload;
  return JOB_LAUNCH_NOTICE + "\n" + payload;
}

export function buildCarrierResultSystemReminder(input: CarrierResultSystemReminderInput): string {
  const lines = [`- ${input.jobId}: ${sanitizeReminderText(input.summary.summary)}`];
  const metadata = [
    `kind=${input.kind}`,
    `status=${input.status}`,
    input.label ? `label=${sanitizeReminderText(input.label)}` : undefined,
    input.taskforceBackend ? `backend=${sanitizeReminderText(input.taskforceBackend)}` : undefined,
    input.error ? `error=${sanitizeReminderText(input.error)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  if (metadata.length > 0) lines.push(`  ${metadata.join(" ")}`);
  return wrapSystemReminder(`${CARRIER_RESULT_PUSH_PREFIX}\n${lines.join("\n")}`, { source: "carrier-completion" });
}

export function wrapSystemReminder(text: string, attrs?: SystemReminderAttributes): string {
  const renderedAttrs = renderSystemReminderAttributes(attrs);
  return `<system-reminder${renderedAttrs}>\n${text}\n</system-reminder>`;
}

function sanitizeReminderText(text: string): string {
  return escapeXmlText(
    text
      .replace(REMINDER_CONTROL_CHARS, " ")
      .replace(REMINDER_WHITESPACE, " ")
      .trim()
      .slice(0, REMINDER_TEXT_LIMIT),
  );
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

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
