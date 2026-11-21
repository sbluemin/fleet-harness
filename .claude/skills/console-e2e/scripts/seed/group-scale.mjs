#!/usr/bin/env node
/**
 * Rewrite the `ledger` profile's synthetic transcripts to group-conversation scale: one long group and one short control.
 * No model call and no Console API call; it writes only the transcripts the ledger seed bound inside an owned run.
 *
 *   node isolated-env.mjs --run-dir <run> -- node group-scale.mjs --dir <run>/console --claude-config-dir <run>/claude [--long-turns 500] [--short-turns 30]
 *
 * Ownership. It must run inside the isolated-env wrapper: `--dir` and `--claude-config-dir` have to be the same real paths as the
 * wrapper's FLEET_CONSOLE_DATA_DIR and CLAUDE_CONFIG_DIR, be that run's `console` and `claude` directories, and the run directory
 * must carry the registration records (`.e2e-run.json`, `owner`). Before the first write, every transcript it will replace is
 * checked: the objective record binds it, it is a regular file (not a link), and its real path is exactly the path the product
 * derives from the config dir, the session's working directory and its id, below the real config dir. Any refusal writes nothing.
 *
 * Run it on a slot that `seed.mjs --profile ledger` already filled, with that Console STOPPED (a live host can rewrite the same
 * files), then start the same slot again: the restored sessions replay these transcripts onto the group screen.
 * "Ledger Alpha" becomes the long group, "Ledger Beta" the short control. One turn = one human dispatch + one reply (two rows).
 * A turn count is split over the commander and its members, so no participant nears the product's per-participant history cap
 * (600 events, 3 per turn) and the screen carries no truncation notice. The default long group is 500 turns = 1000 rows (>= the
 * product's 100-row deferral threshold); the short control is 30 turns = 60 rows (below it).
 *
 * Every user/reply text carries a marker `GS-<ALPHA|BETA>-<role>-T<nnn>-<Q|A>`, so a screen check can name the participant and
 * the turn it expects. stdout is one JSON object, also saved as <dir>/group-scale.json: per group its root objective id, the
 * participants with turn and row counts and first/last markers, and the `expect` object that group-ready-gate.js judges.
 * An existing group-scale.json stops the run.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib.mjs";
import { transcriptFile, writeTranscript } from "./transcript.mjs";

export const MARKER_FILE = "group-scale.json";
const GROUPS = [
  { key: "ALPHA", title: "Ledger Alpha", kind: "long", flag: "long-turns", fallback: 500 },
  { key: "BETA", title: "Ledger Beta", kind: "short", flag: "short-turns", fallback: 30 },
];
// Each turn is dispatch + reply + a turn-end the product derives from timestamps: 3 history events. The product keeps 600 per participant.
const MAX_TURNS_PER_PARTICIPANT = 190;
// The long group must stay above the product's deferral threshold and the short control below it, or the pair would not contrast.
const ROW_FLOOR_LONG = 200;
const ROW_CEIL_SHORT = 90;
const BASE_AT = Date.parse("2026-01-01T00:00:00.000Z");

const fail = (message) => { console.error(`group-scale: ${message}`); process.exit(1); };

export const marker = (group, role, turn, side) => `GS-${group}-${role}-T${String(turn).padStart(3, "0")}-${side}`;

/** Split `total` turns over `parts` participants as evenly as possible; the first participants take the remainder. */
export function splitTurns(total, parts) {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0));
}

/** Turns for one participant: the user text and the reply both start with their marker. */
export function turnsFor(group, role, count) {
  return Array.from({ length: count }, (_, index) => {
    const turn = index + 1;
    return {
      user: `${marker(group, role, turn, "Q")} synthetic question ${turn} for ${role}`,
      assistant: `${marker(group, role, turn, "A")} synthetic reply ${turn} from ${role}`,
    };
  });
}

function objectiveRecord(consoleDir, commodoreId, objectiveId) {
  return JSON.parse(readFileSync(path.join(consoleDir, "commodore", commodoreId, "objectives", objectiveId, "objective.json"), "utf8"));
}

function boundTranscript(doc, sessionId) {
  const rows = [doc, ...(Array.isArray(doc.sessions) ? doc.sessions : [])];
  const hit = rows.find((row) => row && row.id === sessionId);
  return hit?.session?.transcriptPath ?? null;
}

function transcriptCwd(file) {
  const first = readFileSync(file, "utf8").split("\n", 1)[0];
  const cwd = JSON.parse(first).cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error(`no absolute cwd in ${file}`);
  return cwd;
}

/** Pure plan: what every group and participant will hold. Exported for the test. */
export function planGroups(ledger, { longTurns, shortTurns }) {
  const totals = { long: longTurns, short: shortTurns };
  return GROUPS.map((spec) => {
    const found = (ledger.objectives ?? []).find((objective) => objective.title === spec.title);
    if (!found) throw new Error(`seed-ids.json has no objective "${spec.title}"; seed the ledger profile first`);
    const people = [{ objectiveId: found.objectiveId, role: "commander", kind: "commander" }, ...found.members.map((member) => ({ objectiveId: member.id, role: member.role, kind: "member" }))];
    const counts = splitTurns(totals[spec.kind], people.length);
    return { spec, rootObjectiveId: found.objectiveId, participants: people.map((person, index) => ({ ...person, turns: counts[index] })) };
  });
}

export function validateTurns({ longTurns, shortTurns }) {
  for (const [name, value] of [["--long-turns", longTurns], ["--short-turns", shortTurns]]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (longTurns * 2 < ROW_FLOOR_LONG) throw new Error(`--long-turns ${longTurns} gives ${longTurns * 2} rows; the long group needs at least ${ROW_FLOOR_LONG} to contrast with the short control`);
  if (shortTurns * 2 > ROW_CEIL_SHORT) throw new Error(`--short-turns ${shortTurns} gives ${shortTurns * 2} rows; the short control must stay at or under ${ROW_CEIL_SHORT}`);
  if (Math.ceil(longTurns / 3) > MAX_TURNS_PER_PARTICIPANT) throw new Error(`--long-turns ${longTurns} puts more than ${MAX_TURNS_PER_PARTICIPANT} turns on one participant, past the product's 600-event history cap; the screen would truncate`);
}

const sameReal = (left, right) => { try { return realpathSync(left) === realpathSync(right); } catch { return false; } };
const isFile = (file) => { try { const stat = lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };

/** The inputs must be this wrapper run's own registered console and claude directories; returns their real paths. */
export function ownedRun(dir, configDir, env) {
  const wrapperConsole = env.FLEET_CONSOLE_DATA_DIR;
  const wrapperClaude = env.CLAUDE_CONFIG_DIR;
  if (!wrapperConsole || !wrapperClaude) throw new Error("run this through isolated-env.mjs: FLEET_CONSOLE_DATA_DIR and CLAUDE_CONFIG_DIR are not set");
  if (!sameReal(dir, wrapperConsole)) throw new Error("--dir is not the wrapper's FLEET_CONSOLE_DATA_DIR");
  if (!sameReal(configDir, wrapperClaude)) throw new Error("--claude-config-dir is not the wrapper's CLAUDE_CONFIG_DIR");
  const resolvedDir = realpathSync(dir);
  const resolvedConfig = realpathSync(configDir);
  const runDir = path.dirname(resolvedDir);
  if (resolvedDir !== path.join(runDir, "console") || resolvedConfig !== path.join(runDir, "claude")) throw new Error("--dir and --claude-config-dir must be the console and claude directories of one run directory");
  if (!isFile(path.join(runDir, ".e2e-run.json")) || !isFile(path.join(runDir, "owner"))) throw new Error("the run directory has no registration records (.e2e-run.json, owner): register it with e2e-resources.mjs init first");
  return { resolvedDir, resolvedConfig };
}

/** One transcript to replace: bound by its record, a plain file, at exactly the product-derived path under the real config dir. */
export function checkedTarget(bound, sessionId, resolvedConfig) {
  if (!bound || !isFile(bound)) throw new Error(`no bound transcript (regular file) for ${sessionId}; the ledger seed did not finish`);
  const cwd = transcriptCwd(bound);
  const planned = transcriptFile({ configDir: resolvedConfig, cwd, sessionId });
  if (realpathSync(bound) !== planned || !planned.startsWith(resolvedConfig + path.sep)) throw new Error(`the record binds ${bound} for ${sessionId}, whose real path is not the expected ${planned} under the owned claude directory`);
  return { cwd, planned };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.get("dir");
  const configDir = args.get("claude-config-dir");
  if (typeof dir !== "string") fail("--dir <console-data-dir> is required");
  if (typeof configDir !== "string") fail("--claude-config-dir <owned claude dir> is required");
  let owned;
  try { owned = ownedRun(dir, configDir, process.env); } catch (error) { fail(error.message); }
  const { resolvedDir, resolvedConfig } = owned;
  const marked = path.join(resolvedDir, MARKER_FILE);
  if (existsSync(marked)) fail(`${MARKER_FILE} already exists; take a fresh slot`);
  if (existsSync(path.join(resolvedDir, "console.lock"))) fail("console.lock exists: stop the owned Console first (a live host can rewrite these transcripts), then run this and start the slot again");
  const counts = { longTurns: Number(args.get("long-turns") ?? GROUPS[0].fallback), shortTurns: Number(args.get("short-turns") ?? GROUPS[1].fallback) };
  try { validateTurns(counts); } catch (error) { fail(error.message); }

  let ids;
  try { ids = JSON.parse(readFileSync(path.join(resolvedDir, "seed-ids.json"), "utf8")); } catch { fail("no seed-ids.json: run seed.mjs --profile ledger on this slot first"); }
  if (ids.profile !== "ledger") fail(`seed-ids.json is profile "${ids.profile}", not "ledger"`);
  const entry = ids.commodores?.[0];
  if (!entry) fail("seed-ids.json has no commodore");

  const groups = [];
  try {
    const groupsStaged = [];
    for (const plan of planGroups(entry, counts)) {
      const doc = objectiveRecord(resolvedDir, entry.commodoreId, plan.rootObjectiveId);
      // Check every participant of every group before the first write, so a refusal never leaves a half-rewritten slot.
      const staged = plan.participants.map((person) => {
        const bound = boundTranscript(doc, person.objectiveId);
        try { return { person, bound, ...checkedTarget(bound, person.objectiveId, resolvedConfig) }; }
        catch (error) { throw new Error(`${plan.spec.title}/${person.role}: ${error.message}`); }
      });
      groupsStaged.push({ plan, staged });
    }
    for (const { plan, staged } of groupsStaged) {
      const participants = [];
      let lane = 0;
      for (const { person, bound, cwd, planned } of staged) {
        const turns = turnsFor(plan.spec.key, person.role, person.turns);
        const written = writeTranscript({ configDir: resolvedConfig, cwd, sessionId: person.objectiveId, turns, at: BASE_AT + lane * 300 });
        if (written.path !== planned) throw new Error(`${plan.spec.title}/${person.role}: wrote ${written.path}, not ${planned}`);
        lane += 1;
        participants.push({
          objectiveId: person.objectiveId,
          role: person.role,
          kind: person.kind,
          turns: person.turns,
          rows: person.turns * 2,
          firstMarker: marker(plan.spec.key, person.role, 1, "Q"),
          lastMarker: marker(plan.spec.key, person.role, person.turns, "A"),
          transcriptPath: bound,
        });
      }
      const rows = participants.reduce((sum, item) => sum + item.rows, 0);
      groups.push({
        title: plan.spec.title,
        kind: plan.spec.kind,
        rootObjectiveId: plan.rootObjectiveId,
        turns: participants.reduce((sum, item) => sum + item.turns, 0),
        rows,
        participants,
        // The object group-ready-gate.js judges against. Rows are a floor, never an exact count.
        expect: {
          rootObjectiveId: plan.rootObjectiveId,
          title: plan.spec.title,
          participants: participants.map(({ objectiveId, role, rows: own, firstMarker, lastMarker }) => ({ objectiveId, role, rows: own, firstMarker, lastMarker })),
        },
      });
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const out = { profile: "group-scale", unit: "one turn = one human dispatch + one reply = two rows", commodoreId: entry.commodoreId, theaters: entry.theaters, groups };
  writeFileSync(marked, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) main();
