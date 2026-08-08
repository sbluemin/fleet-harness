import { afterEach, describe, expect, it } from "vitest";

import { suppressSqliteExperimentalWarning } from "../../cli/suppress-sqlite-warning.js";

const originalEmitWarning = process.emitWarning;

afterEach(() => {
  process.emitWarning = originalEmitWarning;
});

describe("suppressSqliteExperimentalWarning", () => {
  it("SQLite ExperimentalWarning만 드랍하고 다른 경고는 통과시킨다", async () => {
    suppressSqliteExperimentalWarning();
    const seen: string[] = [];
    const listener = (warning: Error) => {
      seen.push(warning.message);
    };
    process.on("warning", listener);
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning(new Error("SQLite is an experimental feature and might change at any time"));
    process.emitWarning("some other warning");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("warning", listener);
    expect(seen).toEqual(["some other warning"]);
  });
});
