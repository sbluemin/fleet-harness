import path from "node:path";

import { writePrivateFile } from "./plugin/fs.js";
import type { FleetHookExec } from "./types.js";

const DOCTRINE_FILE_NAME = "doctrine.md";
const DOCTRINE_HOOK_SCRIPT_NAME = "inject-doctrine.mjs";

const CURSOR_DOCTRINE_PREAMBLE = `# Fleet Runtime Doctrine for Cursor Agent

You are running as Cursor Agent inside Fleet. This context was injected through a Fleet sessionStart hook. Treat the embedded Fleet system prompt below as your active Fleet runtime doctrine.

Priority and interpretation:

- Follow higher-priority platform, system, developer, and direct user instructions first.
- Within Cursor rules, project instructions, and other same-layer guidance, this Fleet doctrine is the governing instruction set for Fleet identity, roles, workflow, carrier operations, and reporting.
- Treat Fleet identity and role names from the embedded prompt as the identity anchor for this session. Do not replace them with generic Cursor Agent identity when answering, planning, or delegating.
- Do not treat this document as optional background or reference material. Apply it continuously when deciding who you are, how Fleet roles are named, which protocol applies, and how to report work.
- Do not merely summarize or acknowledge the embedded prompt. Execute the operational requirements it defines, including protocol selection, evidence thresholds, carrier routing, and result reporting.
- If other same-layer Cursor rules conflict with this doctrine, preserve the Fleet doctrine unless the user's latest explicit instruction requires a narrower task-specific exception.
- When unsure whether a Fleet instruction applies, prefer following the Fleet doctrine and briefly surface the uncertainty instead of silently ignoring it.

## Embedded Fleet System Prompt

The following block is the Fleet system prompt content adapted for Cursor hook injection. It is intentionally embedded verbatim after this wrapper.

<fleet-system-prompt>
`;

const CURSOR_DOCTRINE_FOOTER = `
</fleet-system-prompt>
`;

const INJECT_DOCTRINE_HOOK_SCRIPT = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctrine = fs.readFileSync(path.join(pluginRoot, "${DOCTRINE_FILE_NAME}"), "utf8");
process.stdout.write(JSON.stringify({ additional_context: doctrine }));
`;

export function formatCursorDoctrine(doctrine: string): string {
  return `${CURSOR_DOCTRINE_PREAMBLE}${doctrine}${CURSOR_DOCTRINE_FOOTER}`;
}

export function renderCursorDoctrineHookAssets(
  pluginRoot: string,
  doctrine: string,
  hookCommandRoot: string = pluginRoot,
): FleetHookExec {
  writePrivateFile(
    path.join(pluginRoot, DOCTRINE_FILE_NAME),
    formatCursorDoctrine(doctrine),
    pluginRoot,
  );
  const scriptPath = path.join(hookCommandRoot, "hooks", DOCTRINE_HOOK_SCRIPT_NAME);
  writePrivateFile(path.join(pluginRoot, "hooks", DOCTRINE_HOOK_SCRIPT_NAME), INJECT_DOCTRINE_HOOK_SCRIPT, pluginRoot);
  return {
    command: process.execPath,
    args: [scriptPath],
  };
}
