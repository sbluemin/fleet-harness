import type { CoworkAnnotationDto, CoworkSessionDto } from "../api-types.js";

export type CoworkState = CoworkSessionDto["state"];
export interface CoworkSessionRecord extends CoworkSessionDto {
  createdAt: string;
  updatedAt: string;
  /** Never serialize this field into a HTTP or SSE payload. */
  providerSessionId?: string;
  /** Knowledge-root-relative entry path resolved from the index at session start. Server-only. */
  targetPath?: string;
}
export type CoworkAnnotation = CoworkAnnotationDto;
export interface CoworkTranscriptTurn { role: "user" | "assistant"; text: string; at: string; }
export interface CoworkStoredEvent { id: number; type: "session" | "draft" | "transcript" | "tool" | "done" | "error"; text?: string; session?: CoworkSessionDto; }
