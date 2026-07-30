import { describe, expect, it } from "vitest";

import type { CarrierMetadata, CarrierRequest } from "../../src/index.js";
import { NIMITZ_METADATA, formatRequestBlocksGuide, parseCarrierRequest, validateParsedRequiredRequestBlocks, validateRequiredRequestBlocks } from "../../src/index.js";

const META: CarrierMetadata = {
  category: "operations",
  outputFormat: "",
  permissions: [],
  requestBlocks: [
    { tag: "assignment", required: true, hint: "Assigned work." },
    { tag: "objective", required: false, hint: "Optional goal restatement." },
  ],
  summary: "Executes structured work",
  title: "Operator",
  whenNotToUse: [],
  whenToUse: [],
};

describe("validateRequiredRequestBlocks", () => {
  it("accepts requests containing all required blocks", () => {
    const result = validateRequiredRequestBlocks(META, "<assignment>implement the requested change</assignment>", "alpha");

    expect(result.ok).toBe(true);
  });

  it("validates a dispatch-owned parsed request without reparsing raw text", () => {
    const parsed: CarrierRequest = {
      blocks: [
        { tag: "assignment", hint: "Assigned work.", required: true, present: true, body: "implement the requested change" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
      ],
      additional: "literal observer residual",
    };

    expect(validateParsedRequiredRequestBlocks(META, parsed, "alpha")).toEqual({ ok: true });
  });

  it("echoes the full request-block contract in the rejection error", () => {
    const result = validateRequiredRequestBlocks(META, "do the thing", "alpha");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["assignment"]);
    expect(result.error).toContain('Missing required request block(s) for carrier "alpha"');
    // 자기회복 폴백: 계약을 미리 로드하지 않았어도 에러만으로 재작성 가능해야 한다.
    expect(result.error).toContain("<assignment> required: Assigned work.");
    expect(result.error).toContain("<objective?> optional: Optional goal restatement.");
  });

  it("rejects required blocks with an empty body", () => {
    const result = validateRequiredRequestBlocks(META, "<assignment>   </assignment>", "alpha");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("(empty body)");
  });

  it("accepts a required top-level block whose body contains unbalanced literal markup", () => {
    const request = "<assignment>Use <unknown> literally</assignment>";

    expect(validateRequiredRequestBlocks(META, request, "alpha")).toEqual({ ok: true });
    expect(parseCarrierRequest(META, request).blocks[0]).toMatchObject({ present: true, body: "Use <unknown> literally" });
  });

  it("rejects a Nimitz request without required context/problem even when audit_focus is present", () => {
    const result = validateRequiredRequestBlocks(NIMITZ_METADATA, "<audit_focus>Check ownership</audit_focus>", "nimitz");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["context", "problem"]);
    expect(result.error).toContain("<context> required:");
    expect(result.error).toContain("<problem> required:");
  });
});

describe("formatRequestBlocksGuide", () => {
  it("renders required and optional block signatures with hints", () => {
    expect(formatRequestBlocksGuide(META)).toEqual([
      "  - <assignment> required: Assigned work.",
      "  - <objective?> optional: Optional goal restatement.",
    ]);
  });

  it("returns no lines for blockless metadata", () => {
    expect(formatRequestBlocksGuide({ ...META, requestBlocks: [] })).toEqual([]);
  });
});

describe("parseCarrierRequest", () => {
  it("keeps configured metadata order and removes only first balanced top-level recognized blocks", () => {
    const request = "prefix <objective source=\"host\">  exact <unknown>x</unknown> & <script>literal</script>  </objective> middle <assignment>first</assignment><assignment>duplicate</assignment> tail";

    expect(parseCarrierRequest(META, request)).toEqual({
      blocks: [
        { tag: "assignment", hint: "Assigned work.", required: true, present: true, body: "first" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: true, body: "  exact <unknown>x</unknown> & <script>literal</script>  " },
      ],
      additional: "prefix  middle <assignment>duplicate</assignment> tail",
    });
  });

  it("distinguishes missing and explicitly empty blocks while preserving malformed and nested markup", () => {
    const request = "before <assignment></assignment><unknown><objective>nested</objective></unknown><objective>unterminated";
    const parsed = parseCarrierRequest(META, request);

    expect(parsed.blocks).toEqual([
      { tag: "assignment", hint: "Assigned work.", required: true, present: true, body: "" },
      { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
    ]);
    expect(parsed.additional).toBe("before <unknown><objective>nested</objective></unknown><objective>unterminated");
  });

  it.each([
    ["unmatched prose markup", "use <draft> wording <assignment>W1</assignment>", "use <draft> wording "],
    ["generic-looking literals", "Foo<T> <assignment>W1</assignment>", "Foo<T> "],
  ])("preserves %s before a later configured block", (_case, request, additional) => {
    expect(validateRequiredRequestBlocks(META, request, "alpha")).toEqual({ ok: true });
    expect(parseCarrierRequest(META, request)).toEqual({
      blocks: [
        { tag: "assignment", hint: "Assigned work.", required: true, present: true, body: "W1" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
      ],
      additional,
    });
  });

  it("parses and validates configured tags containing dots", () => {
    const meta: CarrierMetadata = {
      ...META,
      requestBlocks: [{ tag: "foo.bar", required: true, hint: "Dot-containing tag." }],
    };
    const request = "before <foo.bar source=\"test\"> ok </foo.bar> after";

    expect(validateRequiredRequestBlocks(meta, request, "custom")).toEqual({ ok: true });
    expect(parseCarrierRequest(meta, request)).toEqual({
      blocks: [{ tag: "foo.bar", required: true, hint: "Dot-containing tag.", present: true, body: " ok " }],
      additional: "before  after",
    });
  });

  it("places a blockless request entirely in Additional without transforming sensitive-shaped literals", () => {
    const request = "  /tmp/fake & token=sk-not-redacted <script>literal</script>\n";

    expect(parseCarrierRequest({ ...META, requestBlocks: [] }, request)).toEqual({ blocks: [], additional: request });
  });

  it("handles repeated unterminated tag prefixes without rescanning their suffixes", () => {
    const request = "<unknown".repeat(2_000);

    expect(parseCarrierRequest(META, request)).toEqual({
      blocks: [
        { tag: "assignment", hint: "Assigned work.", required: true, present: false, body: "" },
        { tag: "objective", hint: "Optional goal restatement.", required: false, present: false, body: "" },
      ],
      additional: request,
    });
  });
});
