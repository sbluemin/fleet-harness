import { expect, it } from "vitest";

import { ANALYST_KOREAN_LANGUAGE_INSTRUCTION, ANALYST_SYSTEM_PROMPT, resolveAnalystSystemPrompt } from "../src/prompt.js";

it("snapshots the approved observer, evidence, and artifact contract", () => {
  expect({
    sections: ["# Identity", "# Intent gate", "# Evidence contract", "# Intent drift review", "# Retrieval discipline", "# Output contract", "# Tone"].map((section) => ANALYST_SYSTEM_PROMPT.includes(section)),
    identity:
      ANALYST_SYSTEM_PROMPT.includes("You are Session Analyst") &&
      ANALYST_SYSTEM_PROMPT.includes("Your subject is the observed session") &&
      ANALYST_SYSTEM_PROMPT.includes("authority only to inspect") &&
      ANALYST_SYSTEM_PROMPT.includes("non-intervening meta-observer"),
    directAnswer:
      ANALYST_SYSTEM_PROMPT.includes("Identity, capability, limits, usage, or out-of-scope") &&
      ANALYST_SYSTEM_PROMPT.includes("Use zero tools") &&
      ANALYST_SYSTEM_PROMPT.includes("do not add session citations"),
    currentState:
      ANALYST_SYSTEM_PROMPT.includes("call live_tail first") &&
      ANALYST_SYSTEM_PROMPT.includes("Do not require session_outline before it"),
    broadHistory:
      ANALYST_SYSTEM_PROMPT.includes("Broad history, session overview") &&
      ANALYST_SYSTEM_PROMPT.includes("use session_outline when its aggregate map is useful"),
    minimumEvidence: ANALYST_SYSTEM_PROMPT.includes("minimum evidence tools"),
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
    visibleArtifact: ANALYST_SYSTEM_PROMPT.includes("# Artifact design")
      && ANALYST_SYSTEM_PROMPT.includes("var(--fleet-ink, #e8e8e8)")
      && ANALYST_SYSTEM_PROMPT.includes("never branch on prefers-color-scheme")
      && ANALYST_SYSTEM_PROMPT.includes("<cite>e91</cite>")
      && !ANALYST_SYSTEM_PROMPT.includes("do not rely on inherited Console theme variables"),
    size: ANALYST_SYSTEM_PROMPT.includes("50KiB"),
  }).toMatchInlineSnapshot(`
    {
      "artifact": true,
      "artifactArguments": true,
      "broadHistory": true,
      "citation": true,
      "currentState": true,
      "directAnswer": true,
      "identity": true,
      "intentDriftAbstention": true,
      "intentDriftAdvisory": true,
      "intentDriftCausalLimit": true,
      "intentDriftEvidence": true,
      "intentDriftRequest": true,
      "likely": true,
      "minimumEvidence": true,
      "sections": [
        true,
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

it("adds the exact approved Korean output instruction only for Korean sessions", () => {
  const instruction = "\n\n# Language\nWrite every user-facing response in Korean (한국어): answers, follow-up suggestions, artifact titles, and artifact body text. Keep code, commands, file paths, identifiers, and protocol tokens in their original form.";
  expect(ANALYST_KOREAN_LANGUAGE_INSTRUCTION).toBe(instruction);
  expect(resolveAnalystSystemPrompt("ko")).toBe(`${ANALYST_SYSTEM_PROMPT}${instruction}`);
  expect(resolveAnalystSystemPrompt("en")).toBe(ANALYST_SYSTEM_PROMPT);
  expect(resolveAnalystSystemPrompt()).toBe(ANALYST_SYSTEM_PROMPT);
});
