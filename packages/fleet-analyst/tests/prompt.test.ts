import { expect, it } from "vitest";

import { ANALYST_SYSTEM_PROMPT } from "../src/prompt.js";

it("snapshots the approved observer, evidence, and artifact contract", () => {
  expect({
    sections: ["# Role", "# Evidence contract", "# Intent drift review", "# Retrieval discipline", "# Output contract", "# Tone"].map((section) => ANALYST_SYSTEM_PROMPT.includes(section)),
    thirdPerson: ANALYST_SYSTEM_PROMPT.includes('third person as "the agent"'),
    citation: ANALYST_SYSTEM_PROMPT.includes("[e#]"),
    likely: ANALYST_SYSTEM_PROMPT.includes("Likely:"),
    intentDriftRequest: ANALYST_SYSTEM_PROMPT.includes("only when asked to assess intent alignment or drift"),
    intentDriftEvidence:
      ANALYST_SYSTEM_PROMPT.includes("only with two citations") &&
      ANALYST_SYSTEM_PROMPT.includes("one [e#] for a still-active direct user") &&
      ANALYST_SYSTEM_PROMPT.includes("a later [e#] for observed agent behavior"),
    intentDriftAbstention: ANALYST_SYSTEM_PROMPT.includes('report "insufficient evidence" rather than drift'),
    intentDriftAdvisory:
      ANALYST_SYSTEM_PROMPT.includes("non-binding third-party operator advisory") &&
      ANALYST_SYSTEM_PROMPT.includes("never an instruction to the agent") &&
      ANALYST_SYSTEM_PROMPT.includes("remains open to engineering judgment"),
    intentDriftCausalLimit:
      ANALYST_SYSTEM_PROMPT.includes("use newly observed behavior") &&
      ANALYST_SYSTEM_PROMPT.includes('prefix causal claims with "Likely:"') &&
      ANALYST_SYSTEM_PROMPT.includes("must not infer causation from agreement language or final success alone"),
    artifact: ANALYST_SYSTEM_PROMPT.includes("publish_artifact"),
    artifactArguments: ANALYST_SYSTEM_PROMPT.includes('"html"') && ANALYST_SYSTEM_PROMPT.includes("not `content`"),
    visibleArtifact: ANALYST_SYSTEM_PROMPT.includes("explicit high-contrast foreground and background colors"),
    size: ANALYST_SYSTEM_PROMPT.includes("50KiB"),
  }).toMatchInlineSnapshot(`
    {
      "artifact": true,
      "artifactArguments": true,
      "citation": true,
      "intentDriftAbstention": true,
      "intentDriftAdvisory": true,
      "intentDriftCausalLimit": true,
      "intentDriftEvidence": true,
      "intentDriftRequest": true,
      "likely": true,
      "sections": [
        true,
        true,
        true,
        true,
        true,
        true,
      ],
      "size": true,
      "thirdPerson": true,
      "visibleArtifact": true,
    }
  `);
});
