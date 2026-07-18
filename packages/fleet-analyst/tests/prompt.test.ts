import { expect, it } from "vitest";
import { ANALYST_SYSTEM_PROMPT } from "../src/prompt.js";
it("keeps observer and evidence restrictions", () => { expect(ANALYST_SYSTEM_PROMPT).toContain("under 120 words"); expect(ANALYST_SYSTEM_PROMPT).toContain("[e#]"); expect(ANALYST_SYSTEM_PROMPT).toContain("Never modify files"); });
