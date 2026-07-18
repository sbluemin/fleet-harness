import { describe, expect, it } from "vitest";

import type { CarrierMetadata, CarrierRequest } from "../../src/index.js";
import { KIROV_METADATA, formatRequestBlocksGuide, parseCarrierRequest, validateParsedRequiredRequestBlocks, validateRequiredRequestBlocks } from "../../src/index.js";

const META: CarrierMetadata = {
  category: "operations",
  outputFormat: "",
  permissions: [],
  requestBlocks: [
    { tag: "task_refs", required: true, hint: "Assigned TaskRefs." },
    { tag: "objective", required: false, hint: "Optional goal restatement." },
  ],
  summary: "Executes plan-driven waves",
  title: "Operator",
  whenNotToUse: [],
  whenToUse: [],
};

describe("validateRequiredRequestBlocks", () => {
  it("accepts requests containing all required blocks", () => {
    const result = validateRequiredRequestBlocks(META, "<task_refs>workspace:plan#W1-A-T1</task_refs>", "ohio");

    expect(result.ok).toBe(true);
  });

  it("validates a dispatch-owned parsed request without reparsing raw text", () => {
    const parsed: CarrierRequest = {
      blocks: [
        { tag: "task_refs", hint: "Assigned TaskRefs.", required: true, present: true, body: "workspace:plan#W1-A-T1" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
      ],
      additional: "literal observer residual",
    };

    expect(validateParsedRequiredRequestBlocks(META, parsed, "ohio")).toEqual({ ok: true });
  });

  it("echoes the full request-block contract in the rejection error", () => {
    const result = validateRequiredRequestBlocks(META, "do the thing", "ohio");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["task_refs"]);
    expect(result.error).toContain('Missing required request block(s) for carrier "ohio"');
    // 자기회복 폴백: 계약을 미리 로드하지 않았어도 에러만으로 재작성 가능해야 한다.
    expect(result.error).toContain("<task_refs> required: Assigned TaskRefs.");
    expect(result.error).toContain("<objective?> optional: Optional goal restatement.");
  });

  it("rejects required blocks with an empty body", () => {
    const result = validateRequiredRequestBlocks(META, "<task_refs>   </task_refs>", "ohio");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("(empty body)");
  });

  it("accepts a required top-level block whose body contains unbalanced literal markup", () => {
    const request = "<task_refs>Use <unknown> literally</task_refs>";

    expect(validateRequiredRequestBlocks(META, request, "ohio")).toEqual({ ok: true });
    expect(parseCarrierRequest(META, request).blocks[0]).toMatchObject({ present: true, body: "Use <unknown> literally" });
  });

  it("rejects a Kirov dispatch without its required plan_id", () => {
    const result = validateRequiredRequestBlocks(KIROV_METADATA, "<goal>Plan the migration</goal>", "kirov");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["plan_id"]);
    expect(result.error).toContain("<plan_id> required:");
  });
});

describe("formatRequestBlocksGuide", () => {
  it("renders required and optional block signatures with hints", () => {
    expect(formatRequestBlocksGuide(META)).toEqual([
      "  - <task_refs> required: Assigned TaskRefs.",
      "  - <objective?> optional: Optional goal restatement.",
    ]);
  });

  it("returns no lines for blockless metadata", () => {
    expect(formatRequestBlocksGuide({ ...META, requestBlocks: [] })).toEqual([]);
  });
});

describe("parseCarrierRequest", () => {
  it("keeps configured metadata order and removes only first balanced top-level recognized blocks", () => {
    const request = "prefix <objective source=\"host\">  exact <unknown>x</unknown> & <script>literal</script>  </objective> middle <task_refs>first</task_refs><task_refs>duplicate</task_refs> tail";

    expect(parseCarrierRequest(META, request)).toEqual({
      blocks: [
        { tag: "task_refs", hint: "Assigned TaskRefs.", required: true, present: true, body: "first" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: true, body: "  exact <unknown>x</unknown> & <script>literal</script>  " },
      ],
      additional: "prefix  middle <task_refs>duplicate</task_refs> tail",
    });
  });

  it("distinguishes missing and explicitly empty blocks while preserving malformed and nested markup", () => {
    const request = "before <task_refs></task_refs><unknown><objective>nested</objective></unknown><objective>unterminated";
    const parsed = parseCarrierRequest(META, request);

    expect(parsed.blocks).toEqual([
      { tag: "task_refs", hint: "Assigned TaskRefs.", required: true, present: true, body: "" },
      { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
    ]);
    expect(parsed.additional).toBe("before <unknown><objective>nested</objective></unknown><objective>unterminated");
  });

  it("places a blockless request entirely in Additional without transforming sensitive-shaped literals", () => {
    const request = "  /tmp/fake & token=sk-not-redacted <script>literal</script>\n";

    expect(parseCarrierRequest({ ...META, requestBlocks: [] }, request)).toEqual({ blocks: [], additional: request });
  });

  it("handles repeated unterminated tag prefixes without rescanning their suffixes", () => {
    const request = "<unknown".repeat(2_000);

    expect(parseCarrierRequest(META, request)).toEqual({
      blocks: [
        { tag: "task_refs", hint: "Assigned TaskRefs.", required: true, present: false, body: "" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
      ],
      additional: request,
    });
  });
});
