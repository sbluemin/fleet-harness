import type { ExtensionAPI, MessageRenderer } from "@sbluemin/fleet-coding-agent";
import { visibleWidth } from "@sbluemin/fleet-tui";

import {
  infra,
  type CarrierJobRecord,
  type CarrierJobSummary,
  type CarrierJobsParams,
} from "@sbluemin/fleet-core";

interface CarrierJobsRenderContext {
  readonly lastComponent?: unknown;
}

interface CarrierJobsRenderResponse {
  action?: string;
  format?: "summary" | "full";
  job_id?: string;
  status?: string;
  active?: CarrierJobRecord[];
  recent?: CarrierJobSummary[];
  summary?: CarrierJobSummary;
  full_result?: string;
  cancelled?: boolean;
  error?: string;
}

export interface CarrierResultMessageDetails {
  jobIds: string[];
  summaries: string[];
}

export interface CarrierJobsToolResult {
  content?: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

interface CarrierJobsVerboseState {
  value: boolean;
}

const ICON = "◈";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const carrierJobsVerboseState: CarrierJobsVerboseState = { value: false };

export const CARRIER_RESULT_CUSTOM_TYPE = "carrier-result";

export const carrierResultRenderer: MessageRenderer<CarrierResultMessageDetails> = () => undefined;

export function registerJob(ctx: ExtensionAPI): void {
  infra.job.configureJobSummaryCache(50, infra.job.detachJobArchive);
  ctx.registerMessageRenderer(CARRIER_RESULT_CUSTOM_TYPE, carrierResultRenderer);
}

export function renderCarrierJobsCall(args: unknown, context: CarrierJobsRenderContext | undefined): CarrierJobsCallComponent | CarrierJobsVerboseCallComponent {
  const typedArgs = args as CarrierJobsParams;
  if (getCarrierJobsVerbose()) {
    const component = context?.lastComponent instanceof CarrierJobsVerboseCallComponent
      ? context.lastComponent
      : new CarrierJobsVerboseCallComponent();
    component.setState(typedArgs);
    return component;
  }
  const component = context?.lastComponent instanceof CarrierJobsCallComponent
    ? context.lastComponent
    : new CarrierJobsCallComponent();
  component.setState(typedArgs);
  return component;
}

export function renderCarrierJobsResult(result: CarrierJobsToolResult): ReturnType<typeof renderQuietResult> | ReturnType<typeof renderVerboseResult> {
  return getCarrierJobsVerbose() ? renderVerboseResult(result) : renderQuietResult(result);
}

export class CarrierJobsCallComponent {
  private args: CarrierJobsParams = { action: "list" };

  setState(args: CarrierJobsParams): void {
    this.args = args;
  }

  render(): string[] {
    return [formatQuietCall(this.args)];
  }

  invalidate(): void {}
}

export class CarrierJobsVerboseCallComponent {
  private args: CarrierJobsParams = { action: "list" };

  setState(args: CarrierJobsParams): void {
    this.args = args;
  }

  render(width = process.stdout.columns ?? 120): string[] {
    return formatJsonLines(this.args, width);
  }

  invalidate(): void {}
}

export function renderQuietResult(_result: CarrierJobsToolResult): { render(): string[]; invalidate(): void } {
  return { render() { return []; }, invalidate() {} };
}

export function renderVerboseResult(result: CarrierJobsToolResult): { render(): string[]; invalidate(): void } {
  return {
    render(width = process.stdout.columns ?? 120) {
      return formatJsonLines(parseResultPayload(result) ?? result, width);
    },
    invalidate() {},
  };
}

export function shortenJobId(jobId: string | undefined): string {
  if (!jobId) return "(none)";
  const separator = jobId.indexOf(":");
  if (separator === -1) return jobId.length <= 14 ? jobId : `…${jobId.slice(-6)}`;
  const prefix = jobId.slice(0, separator + 1);
  const rest = jobId.slice(separator + 1);
  if (rest.length <= 12) return jobId;
  return `${prefix}…${rest.slice(-6)}`;
}

export function getCarrierJobsVerbose(): boolean {
  return getState().value;
}

export function setCarrierJobsVerbose(value: boolean): void {
  const state = getState();
  if (state.value === value) return;
  state.value = value;
}

export function toggleCarrierJobsVerbose(): boolean {
  const next = !getCarrierJobsVerbose();
  setCarrierJobsVerbose(next);
  return next;
}

function formatQuietCall(args: CarrierJobsParams): string {
  const action = args.format ? `${args.action}:${args.format}` : args.action;
  const job = args.action === "list" ? "" : ` · ${shortenJobId(args.job_id)}`;
  return `${DIM}${ICON} Carrier Jobs · ${action}${job}${RESET}`;
}

function parseResultPayload(result: CarrierJobsToolResult): CarrierJobsRenderResponse | null {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as CarrierJobsRenderResponse;
  } catch {
    return null;
  }
}

function formatJsonLines(value: unknown, width = process.stdout.columns ?? 120): string[] {
  const safeWidth = Math.max(20, width);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .flatMap((line) => wrapLine(line, safeWidth))
    .map((line) => `${DIM}${line}${RESET}`);
}

function wrapLine(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const lines: string[] = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const char of line) {
    const charWidth = visibleWidth(char);
    if (chunk && chunkWidth + charWidth > width) {
      lines.push(chunk);
      chunk = char;
      chunkWidth = charWidth;
      continue;
    }
    chunk += char;
    chunkWidth += charWidth;
  }
  if (chunk) lines.push(chunk);
  return lines;
}

function getState(): CarrierJobsVerboseState {
  return carrierJobsVerboseState;
}
