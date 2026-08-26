import { describe, expect, it } from "vitest";

import { renderLineWithSearchRanges } from "../client/viewer/code.js";

describe("file search highlights", () => {
  it("escapes content and marks the selected UTF-16 range", () => {
    const html = renderLineWithSearchRanges("const x = '<tag>';", "plaintext", [{ start: 11, end: 16 }]);
    expect(html).toContain('<mark class="fexp-code-search-mark">&lt;tag&gt;</mark>');
    expect(html).not.toContain("<tag>");
  });
});
