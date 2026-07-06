import { describe, expect, it } from "vitest";

import type { CarrierMetadata } from "../../src/index.js";
import { formatRequestBlocksGuide, validateRequiredRequestBlocks } from "../../src/index.js";

const META: CarrierMetadata = {
  category: "operations",
  outputFormat: "",
  permissions: [],
  requestBlocks: [
    { tag: "plan_file", required: true, hint: "Repo-relative plan path." },
    { tag: "objective", required: false, hint: "Optional goal restatement." },
  ],
  summary: "Executes plan-driven waves",
  title: "Operator",
  whenNotToUse: [],
  whenToUse: [],
};

describe("validateRequiredRequestBlocks", () => {
  it("accepts requests containing all required blocks", () => {
    const result = validateRequiredRequestBlocks(META, "<plan_file>.fleet/plans/x.md</plan_file>", "ohio");

    expect(result.ok).toBe(true);
  });

  it("echoes the full request-block contract in the rejection error", () => {
    const result = validateRequiredRequestBlocks(META, "do the thing", "ohio");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["plan_file"]);
    expect(result.error).toContain('Missing required request block(s) for carrier "ohio"');
    // 자기회복 폴백: 계약을 미리 로드하지 않았어도 에러만으로 재작성 가능해야 한다.
    expect(result.error).toContain("<plan_file> required: Repo-relative plan path.");
    expect(result.error).toContain("<objective?> optional: Optional goal restatement.");
  });

  it("rejects required blocks with an empty body", () => {
    const result = validateRequiredRequestBlocks(META, "<plan_file>   </plan_file>", "ohio");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("(empty body)");
  });
});

describe("formatRequestBlocksGuide", () => {
  it("renders required and optional block signatures with hints", () => {
    expect(formatRequestBlocksGuide(META)).toEqual([
      "  - <plan_file> required: Repo-relative plan path.",
      "  - <objective?> optional: Optional goal restatement.",
    ]);
  });

  it("returns no lines for blockless metadata", () => {
    expect(formatRequestBlocksGuide({ ...META, requestBlocks: [] })).toEqual([]);
  });
});
