import { expect, it } from "vitest";

import { ANALYST_SYSTEM_PROMPT } from "../src/prompt.js";

it("snapshots the approved observer, evidence, and artifact contract", () => {
  expect({
    sections: ["# Role", "# Evidence contract", "# Retrieval discipline", "# Output contract", "# Tone"].map((section) => ANALYST_SYSTEM_PROMPT.includes(section)),
    thirdPerson: ANALYST_SYSTEM_PROMPT.includes('third person as "the agent"'),
    citation: ANALYST_SYSTEM_PROMPT.includes("[e#]"),
    likely: ANALYST_SYSTEM_PROMPT.includes("Likely:"),
    artifact: ANALYST_SYSTEM_PROMPT.includes("publish_artifact"),
    size: ANALYST_SYSTEM_PROMPT.includes("50KiB"),
  }).toMatchInlineSnapshot(`
    {
      "artifact": true,
      "citation": true,
      "likely": true,
      "sections": [
        true,
        true,
        true,
        true,
        true,
      ],
      "size": true,
      "thirdPerson": true,
    }
  `);
});
