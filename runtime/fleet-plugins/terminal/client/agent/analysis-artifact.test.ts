import { describe, expect, it } from "vitest";
import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { ARTIFACT_CSP } from "./analysis-types.js";
import { readFileSync } from "node:fs";
describe("artifact frame", () => {
  it("places the exact CSP first and rejects over-sized content", () => {
    expect(safeArtifactSrcdoc("<script>1</script>")).toBe(`${ARTIFACT_CSP}<script>1</script>`);
    expect(safeArtifactSrcdoc("x".repeat(50 * 1024 + 1))).toBeNull();
  });
  it("keeps sandboxing and in-memory clear controls in the artifact companion", () => {
    const panel = readFileSync(new URL("./analysis-artifacts-panel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('sandbox="allow-scripts"');
    expect(panel).toContain('type: "clear-artifacts"');
  });
});
