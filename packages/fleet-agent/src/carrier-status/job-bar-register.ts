import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import { registerKeybinding } from "@sbluemin/fleet-tui/input";

import { getProgrammaticInput } from "../dedicated-cli/bridge.js";
import {
  bindJobBarStateRuntime,
  disposeJobBarState,
  getState,
  handleCarrierJobStreamEvent,
} from "./job-bar-state.js";

export interface JobBarRegistrationOptions {
  readonly requestResize?: () => void;
  readonly rt: FleetCoreRuntimeContext;
  readonly scheduleRender: () => void;
}

const JOB_BAR_TOGGLE_KEY = "\x1bP";
const JOB_BAR_FRAME_TICK_ACTION = "job-bar-widget-toggle";
const BRACKETED_PASTE_END_MARKER = "\x1b[201~";
const C1_BRACKETED_PASTE_END_MARKER = "\x9B201~";
const CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

export function subscribeJobBar(options: JobBarRegistrationOptions): () => void {
  bindJobBarStateRuntime({
    onCarrierResultReminder: (text) => {
      getProgrammaticInput()?.sendMessage(sanitizeCarrierResultReminder(text), {
        bracketedPaste: true,
        multilineStrategy: "paste-mode",
      });
    },
    onRenderRequest: () => {
      options.requestResize?.();
      options.scheduleRender();
    },
    rt: options.rt,
  });

  registerJobBarToggle(options.scheduleRender);
  const unsubscribe = options.rt.admiral.carrierJobs.streaming.register(handleCarrierJobStreamEvent);

  return () => {
    unsubscribe();
    disposeJobBarState();
  };
}

function registerJobBarToggle(scheduleRender: () => void): void {
  registerKeybinding({
    action: JOB_BAR_FRAME_TICK_ACTION,
    handler: () => {
      const state = getState();
      state.widgetMode = state.widgetMode === "expanded" ? "strip" : "expanded";
      scheduleRender();
    },
    key: JOB_BAR_TOGGLE_KEY,
  });
}

function sanitizeCarrierResultReminder(text: string): string {
  return text
    .split(BRACKETED_PASTE_END_MARKER)
    .join("")
    .split(C1_BRACKETED_PASTE_END_MARKER)
    .join("")
    .replace(CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE, "");
}
