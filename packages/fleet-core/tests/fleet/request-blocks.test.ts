/**
 * request-blocks.test.ts — validateRequiredRequestBlocks 단위 테스트
 */

import { describe, it, expect } from "vitest";
import type { CarrierMetadata } from "../../src/admiral/carrier/types.js";
import { validateRequiredRequestBlocks } from "../../src/admiral/carrier/request-blocks.js";
import {
  buildCarrierSystemPrompt,
  formatRequestBlocksGuide,
  CARRIER_JOBS_SELF_CALL_HINT,
  CARRIER_REQUEST_BREVITY_GUIDELINE,
  PRIOR_JOBS_REQUEST_BLOCK,
} from "../../src/admiral/carrier/prompts.js";
import { CARRIER_METADATA as CHRONICLE } from "../../src/admiral/carrier/personas/chronicle.js";
import { CARRIER_METADATA as GENESIS } from "../../src/admiral/carrier/personas/genesis.js";
import { CARRIER_METADATA as KIROV } from "../../src/admiral/carrier/personas/kirov.js";
import { CARRIER_METADATA as NIMITZ } from "../../src/admiral/carrier/personas/nimitz.js";
import { CARRIER_METADATA as OHIO } from "../../src/admiral/carrier/personas/ohio.js";
import { CARRIER_METADATA as SENTINEL } from "../../src/admiral/carrier/personas/sentinel.js";
import { CARRIER_METADATA as TEMPEST } from "../../src/admiral/carrier/personas/tempest.js";
import { CARRIER_METADATA as VANGUARD } from "../../src/admiral/carrier/personas/vanguard.js";

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
// 빌트인 페르소나 requestBlocks 구조 검증
// ─────────────────────────────────────────────────────────

const ALL_PERSONAS: Array<{ name: string; meta: CarrierMetadata }> = [
  { name: "chronicle", meta: CHRONICLE },
  { name: "genesis", meta: GENESIS },
  { name: "kirov", meta: KIROV },
  { name: "nimitz", meta: NIMITZ },
  { name: "ohio", meta: OHIO },
  { name: "sentinel", meta: SENTINEL },
  { name: "tempest", meta: TEMPEST },
  { name: "vanguard", meta: VANGUARD },
];

describe("빌트인 페르소나 requestBlocks 구조", () => {
  for (const { name, meta } of ALL_PERSONAS) {
    describe(`${name}`, () => {
      it("모든 requestBlock에 non-empty hint가 있어야 함", () => {
        for (const block of meta.requestBlocks) {
          expect(block.hint.trim().length).toBeGreaterThan(0);
        }
      });

      it("동일 페르소나 내에서 태그 이름이 유일해야 함", () => {
        const tags = meta.requestBlocks.map((b) => b.tag);
        expect(new Set(tags).size).toBe(tags.length);
      });

      it("필수 태그가 formatRequestBlocksGuide에 렌더링되어야 함", () => {
        const guide = formatRequestBlocksGuide(meta);
        for (const block of meta.requestBlocks.filter((b) => b.required)) {
          const found = guide.some((line) => line.includes(`<${block.tag}>`));
          expect(found, `required tag <${block.tag}> missing from guide`).toBe(true);
        }
      });
    });
  }
});

// ─────────────────────────────────────────────────────────
// CARRIER_JOBS_SELF_CALL_HINT — 전체 persona Tier-2 주입 검증
// ─────────────────────────────────────────────────────────

describe("CARRIER_JOBS_SELF_CALL_HINT — 전체 persona Tier-2 주입", () => {
  for (const { name, meta } of ALL_PERSONAS) {
    it(`${name}: buildCarrierSystemPrompt에 self-call hint 포함`, () => {
      const prompt = buildCarrierSystemPrompt(meta);
      expect(prompt).toContain(CARRIER_JOBS_SELF_CALL_HINT);
    });
  }

  it("CARRIER_JOBS_SELF_CALL_HINT에 carrier_jobs format:\"full\" 서명 포함", () => {
    expect(CARRIER_JOBS_SELF_CALL_HINT).toContain('format:"full"');
  });

  it("CARRIER_JOBS_SELF_CALL_HINT에 format:\"summary\" fallback 포함", () => {
    expect(CARRIER_JOBS_SELF_CALL_HINT).toContain('format:"summary"');
  });
});

// ─────────────────────────────────────────────────────────
// commonRequestBlocks 병합 렌더링 검증
// ─────────────────────────────────────────────────────────

describe("commonRequestBlocks 병합 렌더링", () => {
  it("<prior_jobs?> 블록이 모든 persona 가이드에 optional로 렌더링됨", () => {
    for (const { name, meta } of ALL_PERSONAS) {
      const guide = formatRequestBlocksGuide(meta);
      const found = guide.some((line) => line.includes("<prior_jobs?>"));
      expect(found, `${name}: <prior_jobs?> missing from guide`).toBe(true);
    }
  });

  it("<prior_jobs?> 블록이 required로 렌더링되지 않음", () => {
    for (const { name, meta } of ALL_PERSONAS) {
      const guide = formatRequestBlocksGuide(meta);
      const wrongRequired = guide.some(
        (line) => line.includes("<prior_jobs>") && !line.includes("<prior_jobs?>"),
      );
      expect(wrongRequired, `${name}: <prior_jobs> rendered as required`).toBe(false);
    }
  });

  it("commonRequestBlocks가 persona-specific blocks와 중복 없이 병합됨", () => {
    const meta = makeMeta({
      requestBlocks: [
        { tag: "objective", hint: "objective hint", required: true },
      ],
      commonRequestBlocks: [
        { tag: "extra_ctx", hint: "extra context", required: false },
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
