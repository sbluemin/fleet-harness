import type { ToolPromptManifest } from "./types.js";

export function deriveToolDescription(manifest: ToolPromptManifest): string {
  return manifest.description;
}

export function deriveToolPromptSnippet(manifest: ToolPromptManifest): string {
  return manifest.promptSnippet;
}

export function deriveToolPromptGuidelines(
  manifest: ToolPromptManifest,
  extras: string[] = [],
): string[] {
  return [
    ...manifest.whenToUse,
    ...manifest.whenNotToUse,
    ...manifest.usageGuidelines,
    ...(manifest.guardrails ?? []),
    ...extras,
  ];
}
