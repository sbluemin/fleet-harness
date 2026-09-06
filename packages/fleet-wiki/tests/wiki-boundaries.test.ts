import { describe, expect, it } from "vitest";

import {
  FLEET_WIKI_BOUNDARY_GUIDELINES,
  FLEET_WIKI_ENTRY_END,
  FLEET_WIKI_RAW_SOURCE_END,
  wrapWikiEntryBoundary,
  wrapWikiRawSourceBoundary,
} from "../src/store.js";

describe("wiki boundaries", () => {
  it("wraps curated wiki entries with escaped attributes", () => {
    const wrapped = wrapWikiEntryBoundary({
      id: `apollo"&<>`,
      updated: `2026-05-05T00:00:00.000Z"&<>`,
      content: "entry body",
    });

    expect(wrapped).toContain(`<<<FLEET_WIKI_ENTRY_BEGIN id="apollo&quot;&amp;&lt;&gt;" trust="curated" updated="2026-05-05T00:00:00.000Z&quot;&amp;&lt;&gt;">>>`);
    expect(wrapped).toContain("entry body");
    expect(wrapped).toContain(FLEET_WIKI_ENTRY_END);
  });

  it("wraps raw sources with escaped attributes", () => {
    const wrapped = wrapWikiRawSourceBoundary({
      ref: `raw/"unsafe<&>.md`,
      content: "raw body",
    });

    expect(wrapped).toContain(`<<<FLEET_WIKI_RAW_SOURCE_BEGIN ref="raw/&quot;unsafe&lt;&amp;&gt;.md" trust="untrusted">>>`);
    expect(wrapped).toContain("raw body");
    expect(wrapped).toContain(FLEET_WIKI_RAW_SOURCE_END);
  });
});
