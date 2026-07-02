import crypto from "node:crypto";

import { stripAnsi } from "./cli.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type JobStatus = "running" | "done" | "error";

interface Job {
  lines: string[];
  status: JobStatus;
  exitCode?: number;
  createdAt: number;
  partialLine: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const TTL_MS = 10 * 60 * 1000;
const TRUNCATION_MARKER = "… (output truncated)";

// ─── state ───────────────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();
const activeKeys = new Map<string, string>();

// ─── functions ───────────────────────────────────────────────────────────────

function makeKey(scope: string, theaterId: string): string {
  return `${scope}:${theaterId}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.createdAt > TTL_MS) {
      jobs.delete(id);
    }
  }
  for (const [key, id] of activeKeys) {
    if (!jobs.has(id)) activeKeys.delete(key);
  }
}

export function createJob(scope: string, theaterId: string): string | null {
  sweep();
  const key = makeKey(scope, theaterId);
  if (activeKeys.has(key)) return null;

  const id = crypto.randomUUID();
  jobs.set(id, {
    lines: [],
    status: "running",
    createdAt: Date.now(),
    partialLine: "",
  });
  activeKeys.set(key, id);
  return id;
}

export function appendChunk(id: string, chunk: string): void {
  const job = jobs.get(id);
  if (!job) return;

  const text = job.partialLine + chunk;
  const parts = text.split("\n");
  job.partialLine = parts.pop() ?? "";

  for (const line of parts) {
    const stripped = stripAnsi(line);
    if (!stripped.trim()) continue;
    if (job.lines.length >= MAX_LINES) {
      if (job.lines[job.lines.length - 1] !== TRUNCATION_MARKER) {
        job.lines.push(TRUNCATION_MARKER);
      }
      break;
    }
    job.lines.push(stripped);
  }
}

export function finishJob(id: string, exitCode: number): void {
  const job = jobs.get(id);
  if (!job) return;

  if (job.partialLine.trim()) {
    const stripped = stripAnsi(job.partialLine);
    if (stripped.trim() && job.lines.length < MAX_LINES) {
      job.lines.push(stripped);
    }
    job.partialLine = "";
  }

  job.status = exitCode === 0 ? "done" : "error";
  job.exitCode = exitCode;

  for (const [key, jid] of activeKeys) {
    if (jid === id) {
      activeKeys.delete(key);
      break;
    }
  }
}

export function getJobResult(
  id: string,
  cursor: number,
): { lines: string[]; nextCursor: number; status: JobStatus; exitCode?: number } | null {
  const job = jobs.get(id);
  if (!job) return null;

  const slice = job.lines.slice(cursor);
  return {
    lines: slice,
    nextCursor: cursor + slice.length,
    status: job.status,
    exitCode: job.exitCode,
  };
}

export function isJobActive(scope: string, theaterId: string): boolean {
  return activeKeys.has(makeKey(scope, theaterId));
}

export function getJobsMapForTest(): Map<string, Job> {
  return jobs;
}

export function getActiveKeysForTest(): Map<string, string> {
  return activeKeys;
}
