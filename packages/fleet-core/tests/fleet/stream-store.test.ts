import { describe, expect, it } from "vitest";

import type { ColBlock } from "../../src/admiral/_shared/agent-runtime.js";
import {
  coalesceTextBlock,
  coalesceThoughtBlock,
  upsertToolBlock,
} from "../../src/admiral/_shared/stream-reducers.js";

describe("stream reducers", () => {
  it("thought, tool, text 순서를 보존하며 인접 text만 병합한다", () => {
    const blocks: ColBlock[] = [];

    coalesceThoughtBlock(blocks, "분석 중...");
    upsertToolBlock(blocks, undefined, "read_file", "running");
    upsertToolBlock(blocks, undefined, "read_file", "completed");
    coalesceTextBlock(blocks, "결과: ");
    coalesceTextBlock(blocks, "성공했습니다.");

    expect(blocks).toEqual([
      { type: "thought", text: "분석 중..." },
      { type: "tool", title: "read_file", status: "completed", toolCallId: undefined },
      { type: "text", text: "결과: 성공했습니다." },
    ]);
  });

  it("text와 thought가 교차하면 별도 블록으로 유지한다", () => {
    const blocks: ColBlock[] = [];

    coalesceTextBlock(blocks, "첫 응답");
    coalesceThoughtBlock(blocks, "생각 중");
    coalesceTextBlock(blocks, "두 번째 응답");

    expect(blocks).toEqual([
      { type: "text", text: "첫 응답" },
      { type: "thought", text: "생각 중" },
      { type: "text", text: "두 번째 응답" },
    ]);
  });

  it("toolCallId가 있으면 title이 달라도 같은 tool 블록을 갱신한다", () => {
    const blocks: ColBlock[] = [];

    upsertToolBlock(blocks, "tool-1", "Read", "running");
    upsertToolBlock(blocks, "tool-1", "Read file", "done");

    expect(blocks).toEqual([
      { type: "tool", title: "Read", status: "done", toolCallId: "tool-1" },
    ]);
  });
});
