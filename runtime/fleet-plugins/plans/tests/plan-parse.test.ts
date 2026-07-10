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
      executionMode: null,
      waves: [
        { index: 1, heading: "Wave 1: Foundation", lanes: [], tasksDone: 2, tasksTotal: 3 },
        { index: 2, heading: "Wave 2: UI", lanes: [], tasksDone: 0, tasksTotal: 1 },
      ],
      tasksDone: 4,
      tasksTotal: 6,
    });
  });

  it("returns zero task counts for a plan without checkboxes", () => {
    expect(parsePlan("# Narrative plan\n\n## Wave 4: Review\nNo tasks yet.")).toEqual({
      title: "Narrative plan",
      executionMode: null,
      waves: [{ index: 4, heading: "Wave 4: Review", lanes: [], tasksDone: 0, tasksTotal: 0 }],
      tasksDone: 0,
      tasksTotal: 0,
    });
  });

  it("handles documents without waves", () => {
    expect(parsePlan("# Loose notes\n- [ ] one\n- [x] two")).toEqual({
      title: "Loose notes",
      executionMode: null,
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
      executionMode: null,
      waves: [{ index: 12, heading: "wAvE 12 Build", lanes: [], tasksDone: 2, tasksTotal: 3 }],
      tasksDone: 2,
      tasksTotal: 3,
    });
  });

  it("excludes fenced examples without letting a different fence marker close the block", () => {
    expect(parsePlan(`
# Real plan
\`\`\`markdown
## Wave 99: Example only
- [ ] example task
~~~
- [x] still fenced
\`\`\`
## Wave 1: Actual work
- [x] shipped
`)).toEqual({
      title: "Real plan",
      executionMode: null,
      waves: [{ index: 1, heading: "Wave 1: Actual work", lanes: [], tasksDone: 1, tasksTotal: 1 }],
      tasksDone: 1,
      tasksTotal: 1,
    });
  });

  it("reads the Execution Topology mode and breaks lanes out while keeping wave totals", () => {
    const result = parsePlan(`
# Execution Topology
- Execution mode: Parallel
- Shared mutable resources: none

# Waves

## Wave 1 — Build
### Lane W1-A — Server
- Exact write set: server/**
- Implementation summary:
  - [x] add route
  - [ ] add parser
### Lane W1-B — Client
- Implementation summary:
  - [x] add panel

## Wave 2 — Verify
### Lane W2-A — QA
- Implementation summary:
  - [ ] run e2e
`);

    expect(result.executionMode).toBe("parallel");
    expect(result.waves).toEqual([
      {
        index: 1,
        heading: "Wave 1 — Build",
        lanes: [
          { id: "W1-A", heading: "W1-A — Server", tasksDone: 1, tasksTotal: 2 },
          { id: "W1-B", heading: "W1-B — Client", tasksDone: 1, tasksTotal: 1 },
        ],
        tasksDone: 2,
        tasksTotal: 3,
      },
      {
        index: 2,
        heading: "Wave 2 — Verify",
        lanes: [{ id: "W2-A", heading: "W2-A — QA", tasksDone: 0, tasksTotal: 1 }],
        tasksDone: 0,
        tasksTotal: 1,
      },
    ]);
    expect(result).toMatchObject({ tasksDone: 2, tasksTotal: 4 });
  });

  it("keeps a lane heading without a WN-X id and marks its id null", () => {
    const result = parsePlan("## Wave 1 — Build\n### Lane Special cleanup\n- [ ] tidy");
    expect(result.waves[0]?.lanes).toEqual([
      { id: null, heading: "Special cleanup", tasksDone: 0, tasksTotal: 1 },
    ]);
  });

  it("parses a Sequential execution mode and ignores fenced mode lines", () => {
    expect(parsePlan("- Execution mode: Sequential\n## Wave 1 — Only").executionMode).toBe("sequential");
    expect(parsePlan("```\n- Execution mode: Parallel\n```\n## Wave 1 — Only").executionMode).toBeNull();
  });
});
