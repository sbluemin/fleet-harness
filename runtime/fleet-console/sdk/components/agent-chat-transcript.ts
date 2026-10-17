import type { ComponentType, ReactNode } from "react";

import type { ConversationReference } from "../conversation/references.js";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry } from "../conversation/types.js";

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

/** Reference-only attachments never open the Operation preview route. */
export type AgentChatTranscriptAttachment = { readonly id: string } | { readonly lapsed: true } | { readonly reference: string };

/**
 * References the person placed inside their words. The text carries `CONVERSATION_REFERENCE_MARK` (`@fleet-console/sdk/conversation`)
 * once per reference, in order; a plain-text bubble shows a token in each place. The author verifies the pairing before sending.
 */
export type AgentChatTranscriptReference = ConversationReference;

/**
 * What a reference token does and wears — the plugin owns its targets. Without `open` a token is not a button; without `mark` it shows
 * only its label. `describe` is the token's accessible name (defaults to the label).
 */
export interface AgentChatReferenceHost {
  readonly open?: (id: string) => void;
  readonly mark?: (id: string) => ReactNode;
  readonly describe?: (reference: AgentChatTranscriptReference) => string;
}

export type AgentChatTranscriptEvent =
  /** Opens a turn. With `by` it is a plugin's line (origin row); without it the person's bubble. */
  | { readonly kind: "dispatch"; readonly text: string; readonly format?: "markdown"; readonly references?: readonly AgentChatTranscriptReference[]; readonly attachments?: readonly AgentChatTranscriptAttachment[]; readonly at?: number; readonly by?: AgentChatTranscriptOrigin; readonly undelivered?: true }
  /** A message a running turn picked up — stays inside that turn. */
  | { readonly kind: "turn-inject"; readonly text: string; readonly format?: "markdown"; readonly references?: readonly AgentChatTranscriptReference[]; readonly attachments?: readonly AgentChatTranscriptAttachment[]; readonly at?: number; readonly by?: AgentChatTranscriptOrigin }
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
  /** How the person's inline references open and look. */
  readonly references?: AgentChatReferenceHost;
}

/**
 * Agent conversation — the conversation-layout grammar Operations use (the person's bubbles on the right, speakers' bubbles on
 * the left with their mongle mark and name, quiet centre lines for everything that is not speech, a working line above the
 * composer), offered to plugins that keep their own conversation. Entries are the public group timeline vocabulary plus `note`.
 */
export type AgentConversationEntry =
  | GroupTimelineEntry
  /** A quiet centre line that is not anyone's speech — a session change, a failure notice. */
  | { readonly kind: "note"; readonly id: string; readonly at: number | null; readonly text: string; readonly tone?: "warn" };

export interface AgentConversationProps {
  readonly entries: readonly AgentConversationEntry[];
  /** Who takes part and what they are doing now — the latest bubble mark of each speaker shows that face. */
  readonly participants: readonly ConversationParticipant[];
  /** Speakers working right now — the working line above the composer. */
  readonly working: readonly ConversationSpeaker[];
  readonly language: "en" | "ko";
  /** The Theater a `commodore` speaker belongs to — its mongle is that Theater's avatar. */
  readonly theaterId?: string;
  /** Still reading the first page — the empty line says so instead of `empty`. */
  readonly loading?: boolean;
  /** The line shown when there are no entries. */
  readonly empty?: string;
  /** Older entries exist above the first one — a text button at the top reads them. The view keeps its place as they arrive. */
  readonly older?: { readonly label: string; readonly loading: boolean; readonly load: () => void } | null;
  /** Bring this entry into view and mark it briefly. A new `nonce` repeats the request for the same entry. */
  readonly reveal?: { readonly entryId: string; readonly nonce: number } | null;
  /**
   * A participant's ledger — the plugin's full turn record for that speaker. When given, the participant's name on its bubbles,
   * its mark and words on the working line and its progress chip open it, with the hit rules an Operation conversation uses (the
   * name is the tab stop, the mark a pointer copy). Omit it while there is no ledger to open; nothing then pretends to be pressable.
   */
  readonly openLedger?: ((speaker: ConversationSpeaker) => void) | null;
  /** A board-action line's link (`label`) and what it opens. Without it the line only unfolds its reason. */
  readonly openBoardAction?: { readonly label: string; readonly open: (entry: Extract<GroupTimelineEntry, { kind: "board-action" }>) => void } | null;
  /** Below the working line — the plugin's own composer or a way back. */
  readonly composer?: ReactNode;
  /** How the person's inline references (a message's `references`) open and look. */
  readonly references?: AgentChatReferenceHost;
}

/** Host-provided chat renderer. Plugins receive it on the install context (`ctx.chat`). */
export interface ClientAgentChatCapability {
  readonly Transcript: ComponentType<AgentChatTranscriptProps>;
  readonly Conversation: ComponentType<AgentConversationProps>;
}
