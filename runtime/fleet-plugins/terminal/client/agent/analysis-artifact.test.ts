import { describe, expect, it } from "vitest";
import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { ARTIFACT_CSP } from "./analysis-types.js";
describe("artifact frame", () => {
  it("places the exact CSP first and rejects over-sized content", () => {
    expect(safeArtifactSrcdoc("<script>1</script>")).toBe(`${ARTIFACT_CSP}<script>1</script>`);
    expect(safeArtifactSrcdoc("x".repeat(50 * 1024 + 1))).toBeNull();
  });
});
