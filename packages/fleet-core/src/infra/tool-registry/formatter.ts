import type { ToolPromptManifest } from "./types.js";

function renderList(items: string[]): string {
  return items
    .map((item) => {
      if (/^\s*(?:\d+\.\s|- )/.test(item)) {
        return item;
      }
      return `- ${item}`;
    })
    .join("\n");
}

function renderToolPromptManifestMarkdown(manifest: ToolPromptManifest): string {
  const sections = [
    `# ${manifest.title}`,
    manifest.description,
    `## When to use\n${renderList(manifest.whenToUse)}`,
    `## Usage guidelines\n${renderList(manifest.usageGuidelines)}`,
  ];

  if (manifest.whenNotToUse.length > 0) {
    sections.splice(3, 0, `## When NOT to use\n${renderList(manifest.whenNotToUse)}`);
  }

  if (manifest.guardrails && manifest.guardrails.length > 0) {
    sections.push(`## Guardrails\n${renderList(manifest.guardrails)}`);
  }

  return sections.join("\n\n");
}

export function renderToolPromptManifestTagBlock(manifest: ToolPromptManifest): string {
  return `<fleet section="tool-guide" tool="${manifest.tag}">\n${renderToolPromptManifestMarkdown(manifest)}\n</fleet>`;
}
