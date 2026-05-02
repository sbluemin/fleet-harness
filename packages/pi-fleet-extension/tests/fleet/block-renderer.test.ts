import { describe, expect, it } from "vitest";

import {
  renderBlockLines,
  blockLineAnsiColor,
  blockLineToAnsi,
} from "../../src/shell/render/block-renderer.js";
import type { ColBlock } from "@sbluemin/fleet-core/admiral/agent-runtime";
import {
  ANSI_RESET,
  PANEL_DIM_COLOR,
  TOOLS_COLOR,
  SYM_INDICATOR,
  SYM_THINKING,
} from "@sbluemin/fleet-core/constants";

const ERROR_COLOR = "\x1b[38;2;255;80;80m";

// ─── renderBlockLines ────────────────────────────────────

describe("renderBlockLines", () => {
  it("완료된 tool 블록을 한 줄로 렌더링하되 suffix/suffixType을 분리한다", () => {
    const blocks: ColBlock[] = [
      { type: "tool", title: "search", status: "completed" },
    ];
    const lines = renderBlockLines(blocks);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.type).toBe("tool-title");
    expect(line.text).toBe(`${SYM_INDICATOR} search`);
    expect(line.suffix).toBe(" completed");
    expect(line.suffixType).toBe("tool-result");
  });

  it("실패한 tool 블록은 error 타입으로 렌더링한다", () => {
    const blocks: ColBlock[] = [
      { type: "tool", title: "write", status: "failed" },
    ];
    const lines = renderBlockLines(blocks);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.type).toBe("tool-error");
    expect(line.text).toBe(`${SYM_INDICATOR} write`);
    expect(line.suffix).toBe(" failed");
    expect(line.suffixType).toBe("tool-error");
  });

  it("error 상태도 tool-error로 처리한다", () => {
    const blocks: ColBlock[] = [
      { type: "tool", title: "exec", status: "error" },
    ];
    const lines = renderBlockLines(blocks);
    const line = lines[0];
    expect(line.type).toBe("tool-error");
    expect(line.suffixType).toBe("tool-error");
  });

  it("running 상태에서는 suffix가 없다", () => {
    const blocks: ColBlock[] = [
      { type: "tool", title: "fetch", status: "running" },
    ];
    const lines = renderBlockLines(blocks);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.type).toBe("tool-title");
    expect(line.text).toBe(`${SYM_INDICATOR} fetch`);
    expect(line.suffix).toBeUndefined();
    expect(line.suffixType).toBeUndefined();
  });

  it("thought 블록은 기존 형식을 유지한다", () => {
    const blocks: ColBlock[] = [
      { type: "thought", text: "line1\nline2" },
    ];
    const lines = renderBlockLines(blocks);

    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("thought");
    expect(lines[0].text).toBe(`${SYM_THINKING} line1`);
    expect(lines[1].text).toBe("  line2");
  });

  it("text 블록은 기존 형식을 유지한다", () => {
    const blocks: ColBlock[] = [
      { type: "text", text: "hello" },
    ];
    const lines = renderBlockLines(blocks);

    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("text");
    expect(lines[0].text).toBe(`${SYM_INDICATOR} hello`);
    expect(lines[0].suffix).toBeUndefined();
  });
});

// ─── blockLineAnsiColor ─────────────────────────────────

describe("blockLineAnsiColor", () => {
  it("tool-title은 TOOLS_COLOR를 반환한다", () => {
    expect(blockLineAnsiColor("tool-title")).toBe(TOOLS_COLOR);
  });

  it("tool-result은 PANEL_DIM_COLOR를 반환한다", () => {
    expect(blockLineAnsiColor("tool-result")).toBe(PANEL_DIM_COLOR);
  });

  it("tool-error는 ERROR_COLOR를 반환한다", () => {
    expect(blockLineAnsiColor("tool-error")).toBe(ERROR_COLOR);
  });
});

// ─── blockLineToAnsi ────────────────────────────────────

describe("blockLineToAnsi", () => {
  it("완료 tool은 타이틀(TOOLS_COLOR) + 상태(DIM) 분리 색상을 적용한다", () => {
    const result = blockLineToAnsi({
      type: "tool-title",
      text: `${SYM_INDICATOR} search`,
      suffix: " completed",
      suffixType: "tool-result",
    });

    expect(result).toBe(
      `${TOOLS_COLOR}${SYM_INDICATOR} search${ANSI_RESET}${PANEL_DIM_COLOR} completed${ANSI_RESET}`,
    );
  });

  it("에러 tool은 타이틀/상태 모두 ERROR_COLOR를 적용한다", () => {
    const result = blockLineToAnsi({
      type: "tool-error",
      text: `${SYM_INDICATOR} write`,
      suffix: " failed",
      suffixType: "tool-error",
    });

    expect(result).toBe(
      `${ERROR_COLOR}${SYM_INDICATOR} write${ANSI_RESET}${ERROR_COLOR} failed${ANSI_RESET}`,
    );
  });

  it("suffix가 없으면 타이틀만 색상 적용한다", () => {
    const result = blockLineToAnsi({
      type: "tool-title",
      text: `${SYM_INDICATOR} fetch`,
    });

    expect(result).toBe(`${TOOLS_COLOR}${SYM_INDICATOR} fetch${ANSI_RESET}`);
  });

  it("text 타입은 색상 없이 원문 반환한다", () => {
    const result = blockLineToAnsi({
      type: "text",
      text: `${SYM_INDICATOR} hello`,
    });

    expect(result).toBe(`${SYM_INDICATOR} hello`);
  });
});
