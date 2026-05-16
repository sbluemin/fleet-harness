/**
 * request-blocks.test.ts — validateRequiredRequestBlocks 단위 테스트
 */

import { describe, it, expect } from "vitest";
import type { CarrierMetadata } from "../../src/admiral/carrier/types.js";
import { validateRequiredRequestBlocks } from "../../src/admiral/carrier/request-blocks.js";
import {
  formatRequestBlocksGuide,
  CARRIER_REQUEST_BREVITY_GUIDELINE,
} from "../../src/admiral/carrier/prompts.js";
import type { RequestBlock } from "../../src/admiral/carrier/types.js";

const PRIOR_JOBS_REQUEST_BLOCK: RequestBlock = {
  tag: "prior_jobs",
  hint: "Prior finalized carrier job IDs for context lookup.",
  required: false,
};

// ─────────────────────────────────────────────────────────
// 테스트 픽스처
// ─────────────────────────────────────────────────────────

function makeMeta(overrides?: Partial<CarrierMetadata>): CarrierMetadata {
  return {
    title: "Test Captain",
    summary: "Test carrier",
    category: "operations",
    whenToUse: ["testing"],
    whenNotToUse: [],
    permissions: [],
    requestBlocks: [],
    outputFormat: "",
    ...overrides,
  };
}

describe("validateRequiredRequestBlocks", () => {
  it("모든 필수 태그가 존재하면 ok: true 반환", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "objective", hint: "what to do", required: true },
        { tag: "scope", hint: "scope", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      "<objective>build a thing</objective>\n<scope>src/</scope>",
      "test-carrier",
    );
    expect(result.ok).toBe(true);
  });

  it("필수 태그 1개 누락 시 missing 배열에 포함", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "objective", hint: "what to do", required: true },
        { tag: "scope", hint: "scope", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      "<objective>build a thing</objective>",
      "test-carrier",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["scope"]);
      expect(result.error).toContain("<scope>");
      expect(result.error).toContain("test-carrier");
    }
  });

  it("필수 태그 여러 개 누락 시 모두 missing에 포함", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "a", hint: "a", required: true },
        { tag: "b", hint: "b", required: true },
        { tag: "c", hint: "c", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(meta, "", "test-carrier");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["a", "b", "c"]);
      expect(result.error).toContain("<a>");
      expect(result.error).toContain("<b>");
      expect(result.error).toContain("<c>");
    }
  });

  it("속성이 포함된 태그도 허용", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "plan_file", hint: "plan path", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      '<plan_file source="kirov">.fleet/plans/foo.md</plan_file>',
      "ohio",
    );
    expect(result.ok).toBe(true);
  });

  it("optional-only 메타데이터는 항상 ok: true", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "references", hint: "optional refs", required: false },
        { tag: "notes", hint: "optional notes", required: false },
      ],
    });
    const result = validateRequiredRequestBlocks(meta, "", "test-carrier");
    expect(result.ok).toBe(true);
  });

  it("requestBlocks가 비어있으면 ok: true", () => {
    const meta = makeMeta();
    const result = validateRequiredRequestBlocks(meta, "anything", "test-carrier");
    expect(result.ok).toBe(true);
  });

  it("closing tag 누락 시 실패", () => {
    const meta = makeMeta({
      requestBlocks: [{ tag: "objective", hint: "what to do", required: true }],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      "<objective>build a thing",
      "test-carrier",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["objective"]);
      expect(result.error).toContain("missing closing tag");
    }
  });

  it("empty body 시 실패", () => {
    const meta = makeMeta({
      requestBlocks: [{ tag: "objective", hint: "what to do", required: true }],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      "<objective>  </objective>",
      "test-carrier",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["objective"]);
      expect(result.error).toContain("empty body");
    }
  });
});

// ─────────────────────────────────────────────────────────
// 명시 requestBlocks 렌더링 검증
// ─────────────────────────────────────────────────────────

describe("명시 requestBlocks 렌더링", () => {
  it("빈 메타데이터에는 <prior_jobs?> 블록이 자동 렌더링되지 않음", () => {
    const guide = formatRequestBlocksGuide(makeMeta());
    const found = guide.some((line) => line.includes("<prior_jobs?>"));
    expect(found).toBe(false);
  });

  it("PRIOR_JOBS_REQUEST_BLOCK을 명시 포함하면 optional로 렌더링됨", () => {
    const guide = formatRequestBlocksGuide(makeMeta({
      requestBlocks: [PRIOR_JOBS_REQUEST_BLOCK],
    }));
    const found = guide.some((line) => line.includes("<prior_jobs?>"));
    const wrongRequired = guide.some(
      (line) => line.includes("<prior_jobs>") && !line.includes("<prior_jobs?>"),
    );
    expect(found).toBe(true);
    expect(wrongRequired).toBe(false);
  });

  it("명시 requestBlocks가 중복 없이 렌더링됨", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "objective", hint: "objective hint", required: true },
        { tag: "extra_ctx", hint: "extra context", required: false },
        PRIOR_JOBS_REQUEST_BLOCK,
      ],
    });
    const guide = formatRequestBlocksGuide(meta);
    const objLine = guide.filter((l) => l.includes("<objective>"));
    const extraLine = guide.filter((l) => l.includes("<extra_ctx?>"));
    const priorLine = guide.filter((l) => l.includes("<prior_jobs?>"));
    expect(objLine).toHaveLength(1);
    expect(extraLine).toHaveLength(1);
    expect(priorLine).toHaveLength(1);
  });

  it("PRIOR_JOBS_REQUEST_BLOCK은 optional이고 tag가 'prior_jobs'", () => {
    expect(PRIOR_JOBS_REQUEST_BLOCK.required).toBe(false);
    expect(PRIOR_JOBS_REQUEST_BLOCK.tag).toBe("prior_jobs");
  });
});

// ─────────────────────────────────────────────────────────
// prior_jobs 누락이 validateRequiredRequestBlocks를 실패시키지 않음
// ─────────────────────────────────────────────────────────

describe("prior_jobs 누락 no-regression", () => {
  it("prior_jobs 누락 시 validateRequiredRequestBlocks가 ok: true 반환", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "target", hint: "target hint", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(
      meta,
      "<target>some target</target>",
      "test-carrier",
    );
    expect(result.ok).toBe(true);
  });

  it("persona-specific required tag는 여전히 강제됨", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "target", hint: "target hint", required: true },
      ],
    });
    const result = validateRequiredRequestBlocks(meta, "", "test-carrier");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("target");
    }
  });
});

// ─────────────────────────────────────────────────────────
// CARRIER_REQUEST_BREVITY_GUIDELINE — job_id 핸드오프 계약 검증
// ─────────────────────────────────────────────────────────

describe("CARRIER_REQUEST_BREVITY_GUIDELINE — job_id 핸드오프 계약", () => {
  it('format:"full" 서명 포함', () => {
    expect(CARRIER_REQUEST_BREVITY_GUIDELINE).toContain('format:"full"');
  });

  it('format:"summary" fallback 포함', () => {
    expect(CARRIER_REQUEST_BREVITY_GUIDELINE).toContain('format:"summary"');
  });

  it("job_id via <prior_jobs> 지시 포함", () => {
    expect(CARRIER_REQUEST_BREVITY_GUIDELINE).toContain("prior_jobs");
    expect(CARRIER_REQUEST_BREVITY_GUIDELINE).toContain("job_id");
  });
});
