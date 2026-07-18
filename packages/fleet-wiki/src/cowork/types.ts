/** Browser-safe Cowork session state. Provider and filesystem identities are server-only. */
export interface CoworkSessionDto {
  id: string;
  workspaceId: string;
  entryId: string;
  state: "idle" | "running" | "applied" | "closed";
  revision: number;
  draft: string;
  baseHash: string;
  baseVersion: number;
  selection: string | null;
  annotations: readonly CoworkAnnotationDto[];
  /** Original entry markdown captured at session start — the diff baseline for the client. */
  baseDraft: string;
  /** User-chosen agent identity. Safe to expose — provider identities never enter the record. */
  cli?: string;
  model?: string;
  effort?: string;
}

export interface CoworkAnnotationDto { id: string; text: string; start?: number; end?: number; }
export interface CoworkEventDto { type: "session" | "transcript" | "tool" | "done" | "error"; session?: CoworkSessionDto; text?: string; }

export interface CoworkSessionRecord extends CoworkSessionDto {
  createdAt: string;
  updatedAt: string;
  /** Knowledge-root-relative entry path resolved at session start. Server-only. */
  targetPath?: string;
}
export interface CoworkTranscriptTurn { role: "user" | "assistant"; text: string; at: string; }
export interface CoworkStoredEvent { id: number; type: CoworkEventDto["type"]; text?: string; session?: CoworkSessionDto; }
