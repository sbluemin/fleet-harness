import { carrierJobs } from "@sbluemin/fleet-carriers";

import type { JobBarState } from "./job-bar-state.js";

export interface JobBarRegistrationOptions {
  readonly jobBarState: JobBarState;
}

const BRACKETED_PASTE_END_MARKER = "\x1b[201~";
const C1_BRACKETED_PASTE_END_MARKER = "\x9B201~";
const CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

export function subscribeJobBar(options: JobBarRegistrationOptions): () => void {
  const unsubscribe = carrierJobs.streaming.register((event) => options.jobBarState.handleCarrierJobStreamEvent(event));

  return () => {
    unsubscribe();
    options.jobBarState.dispose();
  };
}

export function sanitizeCarrierResultReminder(text: string): string {
  return text
    .split(BRACKETED_PASTE_END_MARKER)
    .join("")
    .split(C1_BRACKETED_PASTE_END_MARKER)
    .join("")
    .replace(CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE, "");
}
