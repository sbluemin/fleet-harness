import type { ComponentType } from "react";

/**
 * Agent chat transcript — the Operation chat view's turn renderer, offered to plugins that keep their own agent transcript.
 *
 * The host owns the renderer (ledger, work fold, answer markdown, live line) and its styles; a plugin hands over an ordered
 * event list and gets the same grammar Operation chat uses. The vocabulary is the public subset of the Operation chat stream
 * a plugin-owned session can produce, plus `note` for transcript dividers. Nothing here reaches a provider session.
 */

/** Who opened a turn when it was not the person — a plugin acting for them. `label` is the shown name; without it the plugin id shows. */
export interface AgentChatTranscriptOrigin {
  readonly kind: "plugin";
  readonly pluginId: string;
  readonly label?: string;
}

export type AgentChatTranscriptEvent =
  /** Opens a turn. With `by` it is a plugin's line (origin row); without it the person's bubble. */
  | { readonly kind: "dispatch"; readonly text: string; readonly format?: "markdown"; readonly at?: number; readonly by?: AgentChatTranscriptOrigin; readonly undelivered?: true }
  /** A message a running turn picked up — stays inside that turn. */
  | { readonly kind: "turn-inject"; readonly text: string; readonly format?: "markdown"; readonly at?: number; readonly by?: AgentChatTranscriptOrigin }
  | { readonly kind: "turn-start"; readonly at?: number }
  /** A completed text block — markdown. The last one before `turn-end` becomes the answer. */
  | { readonly kind: "text"; readonly text: string }
  /** Live-only character delta; the next `text` is its correction anchor. */
  | { readonly kind: "text-delta"; readonly text: string }
  /** Live-only: a tool call whose input is still streaming. A later `tool` with the same id fills it. */
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  /** A tool call — name and one human line. Full inputs never belong here. */
  | { readonly kind: "tool"; readonly name: string; readonly detail: string; readonly id?: string }
  | { readonly kind: "tool-result"; readonly id: string; readonly ok: boolean; readonly summary: string }
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly stopped?: boolean }
  /** A divider between turns — a session change, a failure notice. Closes any open turn. */
  | { readonly kind: "note"; readonly text: string; readonly at?: number; readonly tone?: "warn" };

/** One event and when it happened — the time drives the elapsed clock and thinking gaps. */
export interface AgentChatTranscriptEntry {
  readonly event: AgentChatTranscriptEvent;
  readonly at?: number;
}

export interface AgentChatTranscriptProps {
  readonly entries: readonly AgentChatTranscriptEntry[];
  readonly language: "en" | "ko";
  /** Phone layout — answer actions and spacing follow the mobile chat surface. */
  readonly mobile?: boolean;
  /**
   * Bring the turn that was running at this time into view and mark it briefly. A new `nonce` repeats the request for the
   * same time.
   */
  readonly reveal?: { readonly at: number; readonly nonce: number } | null;
}

/** Host-provided chat renderer. Plugins receive it on the install context (`ctx.chat`). */
export interface ClientAgentChatCapability {
  readonly Transcript: ComponentType<AgentChatTranscriptProps>;
}
