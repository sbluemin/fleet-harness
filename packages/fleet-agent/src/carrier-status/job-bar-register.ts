import { admiral } from "@sbluemin/fleet-admiral";

import { getProgrammaticInput } from "../dedicated-cli/bridge.js";
import {
  bindJobBarStateRuntime,
  disposeJobBarState,
  handleCarrierJobStreamEvent,
} from "./job-bar-state.js";

export interface JobBarRegistrationOptions {
  readonly requestResize?: () => void;
  readonly scheduleRender: () => void;
}

const BRACKETED_PASTE_END_MARKER = "\x1b[201~";
const C1_BRACKETED_PASTE_END_MARKER = "\x9B201~";
const CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

export function subscribeJobBar(options: JobBarRegistrationOptions): () => void {
  bindJobBarStateRuntime({
    onCarrierResultReminder: (text) => {
      getProgrammaticInput()?.sendMessage(sanitizeCarrierResultReminder(text));
    },
    onRenderRequest: () => {
      options.requestResize?.();
      options.scheduleRender();
    },
  });

  const unsubscribe = admiral.carrierJobs.streaming.register(handleCarrierJobStreamEvent);

  return () => {
    unsubscribe();
    disposeJobBarState();
  };
}

function sanitizeCarrierResultReminder(text: string): string {
  return text
    .split(BRACKETED_PASTE_END_MARKER)
    .join("")
    .split(C1_BRACKETED_PASTE_END_MARKER)
    .join("")
    .replace(CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE, "");
}
