import { describe, expect, it } from "vitest";
import { composeTier2Request } from "../../src/admiral/carrier/prompts.js";
import type { CarrierMetadata } from "../../src/admiral/carrier/types.js";

describe("composeTier2Request", () => {
  const dummyRequest = "This is the original request.";

  it("should wrap the entire composed request in <system-reminder> tags", () => {
    const metadata: CarrierMetadata = {
      title: "Test",
      summary: "Test",
      category: "operations",
      whenToUse: [],
      whenNotToUse: [],
      permissions: [],
      requestBlocks: [],
      outputFormat: "",
    };

    const result = composeTier2Request(metadata, dummyRequest);
    expect(result).toMatch(/^<system-reminder>\n/);
    expect(result).toMatch(/\n<\/system-reminder>$/);
  });

  it("should place original request at the top without <request> tags", () => {
    const metadata: CarrierMetadata = {
      title: "Test",
      summary: "Test",
      category: "operations",
      whenToUse: [],
      whenNotToUse: [],
      permissions: [],
      requestBlocks: [],
      outputFormat: "",
    };

    const result = composeTier2Request(metadata, dummyRequest);
    expect(result).not.toContain("<request>");
    expect(result).not.toContain("</request>");
    expect(result).toContain(dummyRequest);
  });

  it("should compose correctly with all sections present without '---' separators", () => {
    const metadata: CarrierMetadata = {
      title: "Test",
      summary: "Test",
      category: "operations",
      whenToUse: [],
      whenNotToUse: [],
      permissions: ["Can read files", "Can write files"],
      requestBlocks: [],
      principles: ["Be polite", "Be fast"],
      outputFormat: "Output in JSON format.",
    };

    const result = composeTier2Request(metadata, dummyRequest);

    // Verify sections are included
    expect(result).toContain("<permissions>\n- Can read files\n- Can write files\n</permissions>");
    expect(result).toContain("<principles>\n- Be polite\n- Be fast\n</principles>");
    expect(result).toContain("<output_format>\nOutput in JSON format.\n</output_format>");

    // Verify the separator '---' is absent
    expect(result).not.toContain("---");

    // Verify exactly 1 <system-reminder> wrapping
    const startTags = result.match(/<system-reminder>/g) || [];
    const endTags = result.match(/<\/system-reminder>/g) || [];
    expect(startTags.length).toBe(1);
    expect(endTags.length).toBe(1);
  });

  it("should format sections separated by double newlines", () => {
    const metadata: CarrierMetadata = {
      title: "Test",
      summary: "Test",
      category: "operations",
      whenToUse: [],
      whenNotToUse: [],
      permissions: ["Read"],
      requestBlocks: [],
      outputFormat: "",
    };

    const result = composeTier2Request(metadata, dummyRequest);
    
    // Expected content string before wrapping
    const expectedContent = `${dummyRequest}\n\n<permissions>\n- Read\n</permissions>`;
    const expectedFinal = `<system-reminder>\n${expectedContent}\n</system-reminder>`;
    
    expect(result).toBe(expectedFinal);
  });
});
