import type { CoworkAnnotationDto, CoworkSessionDto } from "../api-types.js";

export type CoworkState = CoworkSessionDto["state"];
export interface CoworkSessionRecord extends CoworkSessionDto {
  createdAt: string;
  updatedAt: string;
  /** Never serialize this field into a HTTP or SSE payload. */
  providerSessionId?: string;
  cli?: string;
  model?: string;
  effort?: string;
}
export type CoworkAnnotation = CoworkAnnotationDto;
