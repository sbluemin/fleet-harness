import { ARTIFACT_CSP, MAX_ARTIFACT_BYTES } from "./analysis-types.js";
export function safeArtifactSrcdoc(html: string): string | null {
  if (new TextEncoder().encode(html).byteLength > MAX_ARTIFACT_BYTES) return null;
  return `${ARTIFACT_CSP}${html}`;
}
