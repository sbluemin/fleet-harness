/**
 * request-blocks.test.ts — validateRequiredRequestBlocks 단위 테스트
 */

import { describe, it, expect } from "vitest";
import type { CarrierMetadata } from "../../src/admiral/carrier/types.js";
import { validateRequiredRequestBlocks } from "../../src/admiral/carrier/request-blocks.js";
import { formatRequestBlocksGuide } from "../../src/admiral/carrier/prompts.js";
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
