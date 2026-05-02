import type { ColBlock } from "./agent-runtime.js";

export function coalesceTextBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  blocks.push({ type: "text", text });
}

export function coalesceThoughtBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "thought") {
    last.text += text;
    return;
  }
  blocks.push({ type: "thought", text });
}

export function upsertToolBlock(
  blocks: ColBlock[],
  toolCallId: string | undefined,
  title: string,
  status: string,
): void {
  const existing = blocks.find(
    (block): block is Extract<ColBlock, { type: "tool" }> =>
      block.type === "tool" &&
      (toolCallId ? block.toolCallId === toolCallId : block.title === title),
  );

  if (existing) {
    existing.status = status;
    return;
  }

  blocks.push({ type: "tool", title, status, toolCallId });
}
