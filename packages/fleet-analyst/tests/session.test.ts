import { expect, it } from "vitest";

import { AnalystSession } from "../src/session.js";

it("rejects sends before start and disposes idempotently", async () => {
  const session = new AnalystSession({
    capturePath: "/not-used-before-start.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });

  await expect(session.send("hello")).rejects.toThrow("Session not started");
  await expect(session.dispose()).resolves.toBeUndefined();
  await expect(session.dispose()).resolves.toBeUndefined();
});
