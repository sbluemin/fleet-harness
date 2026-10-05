import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { isPidAlive } from "./process.js";

/** `<prefix><creator pid>-<6 random characters>`, the shape mkdtemp gives a `<prefix><pid>-` template. */
const ENTRY_CREATOR = /-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * The key of a Console-owned temporary namespace (docs/console-lifecycle-contract.md, "Console-owned temporary files"): a
 * hash of the real path of what the namespace belongs to, so every spelling of one slot (a symlinked parent, /var and
 * /private/var) lands in the same place and a Console reclaims what an earlier one left under another spelling.
 */
export function consoleNamespaceKey(target: string): string {
  return crypto.createHash("sha256").update(resolveRealPath(target)).digest("hex").slice(0, 12);
}

/** The real path of `target`; a part that does not exist yet keeps its spelling under its nearest existing ancestor. */
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a namespace entry is a leftover the current lock owner may reclaim. Only an entry this process did not create,
 * whose name carries its creator's pid, and whose creator is gone (ESRCH) qualifies — an entry of a Console that is still
 * running stays even when lock exclusivity was broken. An entry under this process's own pid that this process did not
 * create belongs to an earlier process that had the same pid. An entry without a readable creator is never touched.
 */
export function isReclaimableNamespaceEntry(name: string, ownedByThisProcess: ReadonlySet<string>): boolean {
  if (ownedByThisProcess.has(name)) return false;
  const match = ENTRY_CREATOR.exec(name);
  const creator = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(creator) || creator <= 0) return false;
  return creator === process.pid || !isPidAlive(creator);
}
