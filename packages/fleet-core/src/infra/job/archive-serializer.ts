import type { ArchiveBlock, JobArchive } from "./job-types.js";

export function serializeJobArchive(archive: JobArchive): string {
  const lines: string[] = [
    `# Carrier Job Archive`,
    ``,
    `- Job ID: ${archive.jobId}`,
    `- Status: ${archive.status}`,
    `- Truncated: ${archive.truncated ? "yes" : "no"}`,
    `- Created: ${new Date(archive.createdAt).toISOString()}`,
    archive.finalizedAt ? `- Finalized: ${new Date(archive.finalizedAt).toISOString()}` : `- Finalized: pending`,
    ``,
  ];

  const blocks = archive.truncated
    ? [...archive.blocks]
    : [...archive.blocks].sort((a, b) => a.timestamp - b.timestamp);
  if (blocks.length === 0) {
    lines.push(`(no archived output)`);
    return lines.join("\n");
  }

  for (const block of blocks) {
    lines.push(formatBlockHeader(block));
    if (block.kind === "tool_call") {
      lines.push(`- Title: ${block.title ?? "(untitled)"}`);
      lines.push(`- Status: ${block.status ?? "unknown"}`);
      if (block.toolCallId) lines.push(`- Tool Call ID: ${block.toolCallId}`);
      if (block.rawOutput) {
        lines.push(``);
        lines.push("```text");
        lines.push(block.rawOutput);
        lines.push("```");
      }
    } else {
      lines.push(block.text?.trim() || "(empty)");
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

function formatBlockHeader(block: ArchiveBlock): string {
  const label = block.label ? ` / ${block.label}` : "";
  return `## ${new Date(block.timestamp).toISOString()} — ${block.source}${label} — ${block.kind}`;
}
