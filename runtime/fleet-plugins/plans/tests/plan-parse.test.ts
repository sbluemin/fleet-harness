import { describe, expect, it } from "vitest";

import { parsePlan } from "../server/plan-parse.js";

describe("parsePlan", () => {
  it("parses waves and mixed checkbox states while retaining tasks outside waves", () => {
    const result = parsePlan(`
# Fleet rollout
- [x] prepare theater

## Wave 1: Foundation
- [ ] create store
- [X] secure paths

### Detail
- [x] review guard

## Wave 2: UI
- [ ] show plans

# Notes
- [x] publish summary
`);

    expect(result).toEqual({
      title: "Fleet rollout",
      waves: [
        { index: 1, heading: "Wave 1: Foundation", tasksDone: 2, tasksTotal: 3 },
        { index: 2, heading: "Wave 2: UI", tasksDone: 0, tasksTotal: 1 },
      ],
      tasksDone: 4,
      tasksTotal: 6,
    });
  });

  it("returns zero task counts for a plan without checkboxes", () => {
    expect(parsePlan("# Narrative plan\n\n## Wave 4: Review\nNo tasks yet.")).toEqual({
      title: "Narrative plan",
      waves: [{ index: 4, heading: "Wave 4: Review", tasksDone: 0, tasksTotal: 0 }],
      tasksDone: 0,
      tasksTotal: 0,
    });
  });

  it("handles documents without waves", () => {
    expect(parsePlan("# Loose notes\n- [ ] one\n- [x] two")).toEqual({
      title: "Loose notes",
      waves: [],
      tasksDone: 1,
      tasksTotal: 2,
    });
  });

  it("does not adopt Kirov template section headings as the document title", () => {
    const result = parsePlan("# Objective\n\nShip the thing.\n\n## Wave 1 — Build\n- [ ] step");
    expect(result.title).toBeNull();
  });

  it("matches wave and checkbox markers case-insensitively where specified", () => {
    expect(parsePlan("## wAvE 12 Build\n- [X] done\n- [x] also done\n- [ ] later")).toEqual({
      title: null,
      waves: [{ index: 12, heading: "wAvE 12 Build", tasksDone: 2, tasksTotal: 3 }],
      tasksDone: 2,
      tasksTotal: 3,
    });
  });
});
