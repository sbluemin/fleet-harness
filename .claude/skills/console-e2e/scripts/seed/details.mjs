// Populate the commenced fake Commander's board through its real tools, without a provider or restored state.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { until } from "./lib.mjs";

export async function seedDetails({ api, objectiveId, fakeDir }) {
  // The host can report a started session before the fake has saved its MCP config. Bind to this objective, not the newest launch.
  const launch = await until(() => {
    try {
      return readFileSync(path.join(fakeDir, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).reverse()
        .find((row) => row.event === "launch" && row.sessionIdArg === objectiveId && row.mcpServers?.some((server) => server.name === "fleet-commander"));
    } catch { return null; }
  }, 60_000, "fake commander MCP config");
  const tool = (name, args = {}) => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../fake-claude-mcp.mjs", import.meta.url)),
      "--dir", fakeDir, "--pid", String(launch.pid), "--server", "fleet-commander", "--tool", name, "--args", JSON.stringify(args)], { encoding: "utf8" });
    const result = JSON.parse(output);
    const body = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
    if (result.isError || body.error) throw new Error(`details: ${name} refused: ${body.error ?? "tool error"}`);
    return body;
  };
  await api("POST", "/api/v1/objectives/objective/patch", { objectiveId, patch: { note: "Synthetic objective-detail fixture. Review the shared files, completion records and attached results; no provider calls or real build measurements are represented." } });
  for (const text of ["Fixture evidence is attached to mission 1", "Remaining fixture work stays visible"]) {
    await api("POST", "/api/v1/objectives/criterion/add", { objectiveId, criterion: { text } });
  }
  const board = tool("objective_read").objective;
  const [first, second] = board.graph.missions;
  tool("mission_place", { missionId: first.missionId, prerequisites: [] });
  tool("mission_place", { missionId: second.missionId, prerequisites: [{ missionId: first.missionId }], member: board.members[0].id });

  const root = tool("evidence_dir").root;
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "fixture.log"), "Synthetic fixture log; not an actual build or verification result.\n");
  writeFileSync(path.join(root, "fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(path.join(root, "notes.md"), "# Shared fixture notes\n\nSynthetic files for objective-detail verification.\n");
  const log = tool("result_seal", { path: "fixture.log" });
  const image = tool("result_seal", { path: "fixture.png" });
  tool("mission_complete", { missionId: first.missionId, summary: ["Prepared synthetic shared files and attached fixture evidence."], results: [
    { kind: "evidence", evidenceId: log.evidenceId, label: "Synthetic fixture log" },
    { kind: "evidence", evidenceId: image.evidenceId, label: "Synthetic fixture image (1×1)" },
  ] });
  tool("mission_complete", { missionId: first.missionId, summary: ["Added a second fixture record; the dependent mission remains open."] });
  tool("criterion_mark", { n: 1, met: true, evidence: "Fixture files attached to mission 1." });
}
