// Person inbox: one criteria proposal, one review, one open follow-up, one commodore question.
// Commander tools follow details.mjs. Hands and the question go through the commodore sdk-calls file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { until } from "./lib.mjs";

const RETRO = {
  wentWell: [{ point: "Recorded the fixture", because: "The board tools" }],
  fellShort: [{ point: "No live measurement", ifOnly: "A later objective measures" }],
};

export async function seedInbox({ api, make, commodoreId, theaterId, fakeDir }) {
  mkdirSync(fakeDir, { recursive: true });
  const titles = { criteria: "Inbox criteria", review: "Inbox review", followup: "Inbox follow-up" };
  await commodoreTurn(api, make, commodoreId, fakeDir, Object.values(titles).map((title) => ({
    server: "fleet-commodore", tool: "objective", args: { action: "add", title, theaterId },
  })), "Create inbox objectives");
  const created = await until(async () => {
    const list = await make.objectives(commodoreId);
    return Object.values(titles).every((title) => list.some((item) => item.title === title)) ? list : null;
  }, 60_000, "inbox objectives");
  const id = (title) => created.find((item) => item.title === title).id;

  await withCommander(api, make, fakeDir, "plan", id(titles.criteria), (tool) => {
    tool("objective_read");
    tool("plan_propose", { criteria: [{ text: "Queue delay stays under one hour" }] });
  });

  const reviewId = id(titles.review);
  await api("POST", "/api/v1/objectives/criterion/add", { objectiveId: reviewId, criterion: { text: "Contrast is at least 4.5:1" } });
  await make.mission(reviewId, { text: "Measure contrast" });
  await withCommander(api, make, fakeDir, "commence", reviewId, (tool) => {
    const missionId = tool("objective_read").objective.graph.missions[0].missionId;
    tool("mission_complete", { missionId, summary: ["Measured the fixture contrast."] });
    tool("criterion_mark", { n: 1, met: true, evidence: "Fixture contrast." });
    tool("hand_off", { retrospective: RETRO });
  });

  const followId = id(titles.followup);
  await api("POST", "/api/v1/objectives/criterion/add", { objectiveId: followId, criterion: { text: "Upload failure is recorded" } });
  await make.mission(followId, { text: "Inspect upload" });
  await withCommander(api, make, fakeDir, "commence", followId, (tool) => {
    const missionId = tool("objective_read").objective.graph.missions[0].missionId;
    tool("followup", { add: {
      title: "Resume upload",
      summary: "A dropped upload starts over",
      userImpact: "Mobile uploads wait from the start",
      fromMission: missionId,
      brief: "Resume chunked uploads",
      evidence: [{ kind: "command", text: "pnpm test upload" }],
    } });
    tool("mission_complete", { missionId, summary: ["Recorded one follow-up."] });
    tool("criterion_mark", { n: 1, met: true, evidence: "Fixture upload note." });
    tool("hand_off", { retrospective: RETRO });
  });

  const criteriaId = id(titles.criteria);
  await commodoreTurn(api, make, commodoreId, fakeDir, [
    { server: "fleet-commodore", tool: "objective", args: { action: "hand_to_person", objectiveId: criteriaId, target: "criteria", reason: "The threshold is the person's call." } },
    { server: "fleet-commodore", tool: "objective", args: { action: "hand_to_person", objectiveId: reviewId, target: "review", reason: "Review the contrast result." } },
    { server: "fleet-commodore", tool: "objective", args: { action: "hand_to_person", objectiveId: followId, target: "followup", reason: "Pick the follow-up." } },
    { server: "fleet-commodore", tool: "ask", args: {
      action: "send", objectiveId: criteriaId, reason: "The note scope blocks the next mission.",
      questions: [{ header: "Scope", text: "Include internal refactors in the note?", options: [{ label: "Include", description: "List every change" }, { label: "Omit", description: "User-facing only" }] }],
    } },
  ], "Hand inbox items");

  const list = await make.objectives(commodoreId);
  const row = (objectiveId) => list.find((item) => item.id === objectiveId);
  const held = (objective, target) => (objective?.personHolds ?? []).some((hold) => hold.target === target && !hold.settled);
  const criteria = row(criteriaId);
  const review = row(reviewId);
  const follow = row(followId);
  if (!held(criteria, "criteria") || !criteria?.criteriaProposals?.length) throw new Error("inbox: criteria hold is not standing");
  if (!held(review, "review") || !review?.awaitingReview || review?.done) throw new Error("inbox: review hold is not standing");
  if (!held(follow, "followup") || !(follow?.awaitingReview || follow?.done) || !follow?.followups?.some((item) => item.state === "open")) throw new Error("inbox: follow-up hold is not standing");
  const view = await api("POST", "/api/v1/commodore/state", { commodoreId });
  const openAsks = (view?.state?.asks ?? []).filter((ask) => !ask.settled);
  if (openAsks.length !== 1) throw new Error(`inbox: expected 1 open ask, got ${openAsks.length}`);
  return {
    objectives: [
      { objectiveId: criteriaId, title: titles.criteria, kind: "criteria" },
      { objectiveId: reviewId, title: titles.review, kind: "review" },
      { objectiveId: followId, title: titles.followup, kind: "followup" },
    ],
    askOpen: openAsks.length,
  };
}

async function commodoreTurn(api, make, commodoreId, fakeDir, calls, text) {
  const sdkFile = path.join(fakeDir, "sdk-calls");
  const idle = async (what) => until(async () => {
    const row = await make.commodoreRow(commodoreId);
    return row && row.run?.phase !== "turn" && row.run?.phase !== "retrying" && !existsSync(sdkFile) ? row : null;
  }, 60_000, what);
  await idle("commodore idle");
  writeFileSync(sdkFile, JSON.stringify({ calls }));
  await api("POST", "/api/v1/commodore/message", { commodoreId, text });
  await idle(`commodore turn "${text}"`);
}

async function withCommander(api, make, fakeDir, route, objectiveId, fn) {
  const started = route === "plan"
    ? await api("POST", "/api/v1/objectives/plan/request", { objectiveId, context: "Inbox criteria" })
    : await make.commence(objectiveId);
  if (started?.failed?.length) throw new Error(`${route} refused: ${started.failed.map((item) => item.error).join(", ")}`);
  const launch = await until(() => {
    try {
      return readFileSync(path.join(fakeDir, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).reverse()
        .find((row) => row.event === "launch" && row.sessionIdArg === objectiveId && row.mcpServers?.some((server) => server.name === "fleet-commander"));
    } catch { return null; }
  }, 60_000, `commander ${objectiveId}`);
  const tool = (name, args = {}) => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../fake-claude-mcp.mjs", import.meta.url)),
      "--dir", fakeDir, "--pid", String(launch.pid), "--server", "fleet-commander", "--tool", name, "--args", JSON.stringify(args)], { encoding: "utf8" });
    const result = JSON.parse(output);
    const body = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
    if (result.isError || body.error) throw new Error(`inbox: ${name} refused: ${body.error ?? "tool error"}`);
    return body;
  };
  await fn(tool);
}
