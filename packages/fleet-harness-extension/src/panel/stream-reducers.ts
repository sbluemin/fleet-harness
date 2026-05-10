import type { ColBlock } from "./types.js";

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
    // ACP 분할 도착: 후속 tool_call_update의 풍부한 title이 1차 빈약 title을 덮도록.
    // 빈 문자열 update가 기존 값을 지우는 것은 방지.
    if (title) existing.title = title;
    if (status) existing.status = status;
    return;
  }

  blocks.push({ type: "tool", title, status, toolCallId });
}
