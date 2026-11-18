// Ledger profile: one commodore's commenced objectives, each with several members,
// and several synthetic turns on every commander and member. The commodore transcript is not extended.
// People and turn text stay here. transcript.mjs owns the jsonl shape and the capture registration.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { until } from "./lib.mjs";
import { registerTranscript, writeTranscript } from "./transcript.mjs";

const OBJECTIVES = [
  { title: "Ledger Alpha", roles: ["planner", "builder"] },
  { title: "Ledger Beta", roles: ["scout", "writer"] },
];
const TURNS = 2;

function turnsFor(label) {
  return Array.from({ length: TURNS }, (_, index) => {
    const n = index + 1;
    return { user: `${label} note ${n}`, assistant: `${label} synthetic reply ${n}` };
  });
}

function logRows(fakeDir) {
  try {
    return readFileSync(path.join(fakeDir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function commanderLaunch(fakeDir, objectiveId) {
  return logRows(fakeDir).reverse().find((row) => row.event === "launch" && row.sessionIdArg === objectiveId && row.mcpServers?.some((server) => server.name === "fleet-commander")) ?? null;
}

function readRecord(consoleDir, commodoreId, objectiveId) {
  const file = path.join(consoleDir, "commodore", commodoreId, "objectives", objectiveId, "objective.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function recordPresent(doc, sessionId) {
  if (!doc || typeof doc !== "object") return false;
  if (doc.id === sessionId) return true;
  return Array.isArray(doc.sessions) && doc.sessions.some((row) => row && row.id === sessionId);
}

function sessionCwd(doc, sessionId) {
  const rows = [doc, ...(Array.isArray(doc.sessions) ? doc.sessions : [])];
  const hit = rows.find((row) => row && row.id === sessionId);
  if (!hit) throw new Error(`no session record for ${sessionId}`);
  // A stored child has no cwd of its own; the product projects the parent's cwd onto it.
  const own = typeof hit.cwd === "string" && hit.cwd.length > 0 ? hit.cwd : null;
  const cwd = own ?? (sessionId !== doc.id && typeof doc.cwd === "string" ? doc.cwd : null);
  if (!cwd || !path.isAbsolute(cwd)) throw new Error(`no absolute session cwd for ${sessionId}`);
  return cwd;
}

export async function seedLedger({ api, make, commodoreId, theater, fakeDir, configDir, consoleDir }) {
  const model = await make.model();
  const mcp = fileURLToPath(new URL("../fake-claude-mcp.mjs", import.meta.url));
  const objectives = [];

  for (const spec of OBJECTIVES) {
    await until(async () => {
      const row = await make.commodoreRow(commodoreId);
      return row && row.run?.phase !== "turn" && row.run?.phase !== "retrying" ? row : null;
    }, 60_000, "commodore idle");
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(path.join(fakeDir, "sdk-calls"), JSON.stringify({ calls: [{ server: "fleet-commodore", tool: "objective", args: { action: "add", title: spec.title, theaterId: theater.theaterId } }] }));
    await api("POST", "/api/v1/commodore/message", { commodoreId, text: `Create ${spec.title}` });
    const found = await until(async () => (await make.objectives(commodoreId)).find((item) => item.title === spec.title), 60_000, `objective "${spec.title}"`);
    const known = new Set((found.members ?? []).map((member) => member.id));
    const members = [];
    for (const role of spec.roles) {
      await make.member(found.id, { role, launch: { mode: "model", model } });
      const listed = await until(async () => {
        const row = (await make.objectives(commodoreId)).find((item) => item.id === found.id);
        const created = (row?.members ?? []).filter((member) => member?.id && !known.has(member.id));
        return created.length === 1 ? created[0] : null;
      }, 15_000, `member ${role}`);
      known.add(listed.id);
      members.push({ id: listed.id, role: listed.role ?? role, sessionId: listed.id });
    }
    await make.mission(found.id, { text: `${spec.title} fixture mission` });
    const started = await make.commence(found.id);
    if (started?.failed?.length) throw new Error(`commence refused members: ${started.failed.map((item) => `${item.role}:${item.error}`).join(", ")}`);
    await until(async () => {
      const row = (await make.objectives(commodoreId)).find((item) => item.id === found.id);
      return row?.commenced === true && (row.commander?.started === true || row.hasSession === true) ? row : null;
    }, 60_000, `in-progress commander ${spec.title}`);
    objectives.push({ objectiveId: found.id, title: spec.title, sessionId: found.id, members, turns: TURNS });
  }

  for (const entry of objectives) {
    const launch = await until(() => commanderLaunch(fakeDir, entry.objectiveId), 90_000, `commander launch ${entry.title}`);
    const tool = (name, args = {}) => {
      const output = execFileSync(process.execPath, [mcp, "--dir", fakeDir, "--pid", String(launch.pid), "--server", "fleet-commander", "--tool", name, "--args", JSON.stringify(args)], { encoding: "utf8" });
      const result = JSON.parse(output);
      const body = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
      if (result.isError || body.error) throw new Error(`${name} refused: ${body.error ?? "tool error"}`);
      return body;
    };
    tool("member_muster");
    const doc = await until(() => {
      try {
        const current = readRecord(consoleDir, commodoreId, entry.objectiveId);
        const ready = recordPresent(current, entry.sessionId) && entry.members.every((member) => recordPresent(current, member.sessionId));
        return ready ? current : null;
      } catch {
        return null;
      }
    }, 60_000, `session records ${entry.title}`);
    const bind = async (sessionId, label) => {
      const turns = turnsFor(label);
      const { path: transcriptPath } = writeTranscript({ configDir, cwd: sessionCwd(doc, sessionId), sessionId, turns });
      await registerTranscript({ dataDir: consoleDir, recordId: sessionId, sessionId, transcriptPath });
      // The bind message can make the host rewrite the same file. Put the synthetic turns back.
      writeTranscript({ configDir, cwd: sessionCwd(doc, sessionId), sessionId, turns });
    };
    await bind(entry.sessionId, `Commander ${entry.title}`);
    for (const member of entry.members) await bind(member.sessionId, member.role);
  }
  return objectives;
}
