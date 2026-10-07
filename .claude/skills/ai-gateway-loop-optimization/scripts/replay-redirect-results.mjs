#!/usr/bin/env node
// Replays captured caller tool output through Cursor's native redirect result builder
// (`cursorNativeRedirectResultReplies` in upstream/cursor/native/exec-redirect.ts) under the
// output variants a parser must accept, and reports per case whether a candidate source keeps
// its expectation and, when a baseline source is given, whether both agree.
//
// node --experimental-strip-types --no-warnings replay-redirect-results.mjs \
//   --candidate <exec-redirect.ts> [--baseline <exec-redirect.ts>] --cases <cases.json> [--out <report.json>]
//
// A baseline is usually `git show origin/canary:<path> > <scratch>/baseline.ts`.
// cases.json: [{ label, nativeResultType, nativeArgs, output, isError?, variants?, expect? }]
//   expect.identical: true       — every variant must equal the baseline's result (needs --baseline)
//   expect.files: [names]        — files list (names compared after trimEnd + NFC)
//   expect.truncated: boolean    — files.clientTruncated
// Exit code 1 when any expectation fails.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VARIANTS = {
  as_is: (text) => text,
  crlf: (text) => text.replace(/\n/g, "\r\n"),
  trailing_whitespace: (text) => text.split("\n").map((line) => `${line}  `).join("\n"),
  trailing_blank_lines: (text) => `${text}\n \n\n`,
  leading_blank_lines: (text) => `\n \n${text}`,
  nfd: (text) => text.normalize("NFD"),
};

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const load = async (file) => (await import(pathToFileURL(path.resolve(file)).href)).cursorNativeRedirectResultReplies;
const candidatePath = option("--candidate");
const casesPath = option("--cases");
if (!candidatePath || !casesPath) {
  console.error("usage: replay-redirect-results.mjs --candidate <ts> [--baseline <ts>] --cases <json> [--out <json>]");
  process.exit(2);
}
const candidate = await load(candidatePath);
const baseline = option("--baseline") ? await load(option("--baseline")) : undefined;
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

const replay = (build, entry, output) => build(
  { messageId: 1, execId: "replay", nativeResultType: entry.nativeResultType, nativeArgs: entry.nativeArgs },
  output,
  entry.isError === true,
);
const filesOf = (replies) => {
  const success = replies[0]?.execClientMessage?.grepResult?.success;
  return success ? Object.values(success.workspaceResults ?? {})[0]?.files : undefined;
};
const name = (value) => value.trimEnd().normalize("NFC");

const rows = [];
let failures = 0;
for (const entry of cases) {
  for (const variant of entry.variants ?? Object.keys(VARIANTS)) {
    const output = VARIANTS[variant](entry.output);
    const result = replay(candidate, entry, output);
    const row = { label: entry.label, variant, problems: [] };
    if (baseline) row.identical = JSON.stringify(replay(baseline, entry, output)) === JSON.stringify(result);
    if (baseline && entry.expect?.identical && !row.identical) row.problems.push("differs from baseline");
    const files = filesOf(result);
    if (entry.expect?.files) {
      const got = (files?.files ?? []).map(name);
      const want = entry.expect.files.map(name);
      if (JSON.stringify(got) !== JSON.stringify(want)) row.problems.push(`files ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      if (files?.totalFiles !== want.length) row.problems.push(`totalFiles ${files?.totalFiles} != ${want.length}`);
    }
    if (entry.expect?.truncated !== undefined && files?.clientTruncated !== entry.expect.truncated) {
      row.problems.push(`clientTruncated ${files?.clientTruncated} != ${entry.expect.truncated}`);
    }
    if (files) row.files = { count: files.files.length, totalFiles: files.totalFiles, clientTruncated: files.clientTruncated };
    failures += row.problems.length > 0 ? 1 : 0;
    rows.push(row);
  }
}
const summary = {
  rows: rows.length,
  failed: failures,
  ...(baseline ? { identicalToBaseline: rows.filter((row) => row.identical).length } : {}),
};
const report = { summary, rows };
if (option("--out")) fs.writeFileSync(option("--out"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(summary));
for (const row of rows.filter((entry) => entry.problems.length > 0)) console.log(`FAIL ${row.label} [${row.variant}] ${row.problems.join("; ")}`);
process.exitCode = failures > 0 ? 1 : 0;
