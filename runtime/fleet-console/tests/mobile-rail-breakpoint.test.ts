import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MOBILE_CSS = readFileSync(fileURLToPath(new URL("../core/client/src/styles/mobile.css", import.meta.url)), "utf8");

/**
 * The rail exists for a viewport that is short and wide. `orientation` reads the aspect of the
 * visible viewport, which a keyboard inverts: typing into a terminal on a portrait phone left a
 * ~589x300 area that answered "landscape" and grew a tab rail beside the terminal.
 */
describe("mobile tab rail breakpoint", () => {
  it("is bounded by width and height, never by orientation", () => {
    expect(MOBILE_CSS).toContain("@media (min-width: 600px) and (max-height: 560px)");
    expect(MOBILE_CSS).not.toContain("orientation:");
  });

  it("keeps the rail rules inside that one query", () => {
    const query = MOBILE_CSS.slice(MOBILE_CSS.indexOf("@media (min-width: 600px) and (max-height: 560px)"));
    expect(query).toContain(".mobile-frame");
    expect(query).toContain("border-left: 1px solid var(--hairline)");
    // Outside the query the bar stays a bottom bar, so its top border is the default.
    const base = MOBILE_CSS.slice(0, MOBILE_CSS.indexOf("@media (min-width: 600px) and (max-height: 560px)"));
    expect(base).toContain("border-top: 1px solid var(--hairline)");
  });
});
