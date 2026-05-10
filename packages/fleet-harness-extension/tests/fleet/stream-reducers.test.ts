import { describe, expect, it } from "vitest";

import type { ColBlock } from "../../src/panel/types.js";
import {
  coalesceTextBlock,
  coalesceThoughtBlock,
  upsertToolBlock,
} from "../../src/panel/stream-reducers.js";

describe("upsertToolBlock", () => {
  it("동일 toolCallId의 후속 update가 빈약 title을 풍부 title로 덮어쓴다", () => {
    const blocks: ColBlock[] = [];

    // 1차 ACP tool_call (status=pending, rawInput={}, locations=[])
    upsertToolBlock(blocks, "toolu_01", "Read File", "pending");
    expect(blocks).toHaveLength(1);

    // 2차 ACP tool_call_update (인자 채워짐, 풍부 title)
    upsertToolBlock(blocks, "toolu_01", "Read /tmp/probe.txt (1 - 1)", "");

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe("tool");
    if (block.type === "tool") {
      expect(block.title).toBe("Read /tmp/probe.txt (1 - 1)");
      // 빈 status는 기존 pending을 지우지 않음
      expect(block.status).toBe("pending");
    }
  });

  it("후속 update의 status가 채워지면 기존 status를 덮어쓴다", () => {
    const blocks: ColBlock[] = [];

    upsertToolBlock(blocks, "toolu_02", "Read File", "pending");
    upsertToolBlock(blocks, "toolu_02", "Read /tmp/x.txt", "completed");

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type === "tool") {
      expect(block.title).toBe("Read /tmp/x.txt");
      expect(block.status).toBe("completed");
    }
  });

  it("빈 title update는 기존 풍부 title을 지우지 않는다", () => {
    const blocks: ColBlock[] = [];

    upsertToolBlock(blocks, "toolu_03", "Read /tmp/x.txt", "pending");
    upsertToolBlock(blocks, "toolu_03", "", "completed");

    const block = blocks[0];
    if (block.type === "tool") {
      expect(block.title).toBe("Read /tmp/x.txt");
      expect(block.status).toBe("completed");
    }
  });

  it("toolCallId가 다르면 별도 블록으로 누적한다", () => {
    const blocks: ColBlock[] = [];

    upsertToolBlock(blocks, "toolu_a", "Read /tmp/a.txt", "completed");
    upsertToolBlock(blocks, "toolu_b", "Read /tmp/b.txt", "completed");

    expect(blocks).toHaveLength(2);
  });

  it("toolCallId가 없을 때 title 매칭으로 fallback 머지한다", () => {
    const blocks: ColBlock[] = [];

    upsertToolBlock(blocks, undefined, "Find", "pending");
    upsertToolBlock(blocks, undefined, "Find", "completed");

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type === "tool") {
      expect(block.status).toBe("completed");
    }
  });
});

describe("coalesceTextBlock / coalesceThoughtBlock", () => {
  it("연속된 text를 마지막 블록에 병합한다", () => {
    const blocks: ColBlock[] = [];
    coalesceTextBlock(blocks, "hello ");
    coalesceTextBlock(blocks, "world");
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === "text") expect(blocks[0].text).toBe("hello world");
  });

  it("text 사이에 tool 블록이 끼면 새 text 블록을 push한다", () => {
    const blocks: ColBlock[] = [];
    coalesceTextBlock(blocks, "before ");
    upsertToolBlock(blocks, "t1", "Read", "completed");
    coalesceTextBlock(blocks, "after");
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("tool");
    expect(blocks[2].type).toBe("text");
  });

  it("thought 블록도 동일하게 병합한다", () => {
    const blocks: ColBlock[] = [];
    coalesceThoughtBlock(blocks, "thinking... ");
    coalesceThoughtBlock(blocks, "more");
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === "thought") expect(blocks[0].text).toBe("thinking... more");
  });
});
