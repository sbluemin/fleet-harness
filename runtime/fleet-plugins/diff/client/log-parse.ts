import type { LogCommitEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type RefBadgeKind = "head" | "tag" | "branch" | "worktree";

export interface RefBadge {
  readonly label: string;
  readonly kind: RefBadgeKind;
}

// ─── functions ───────────────────────────────────────────────────────────────

export function formatRelTime(entry: LogCommitEntry): string {
  return entry.relTime;
}

export function refBadges(entry: LogCommitEntry): RefBadge[] {
  const badges: RefBadge[] = [];
  for (const ref of entry.refs) {
    if (ref === "HEAD") {
      badges.push({ label: "HEAD", kind: "head" });
    } else if (ref.startsWith("tag: ")) {
      badges.push({ label: ref.slice(5), kind: "tag" });
    } else if (ref.startsWith("refs/worktrees/")) {
      badges.push({ label: ref.slice(15), kind: "worktree" });
    } else if (ref.startsWith("refs/heads/")) {
      badges.push({ label: ref.slice(11), kind: "branch" });
    } else {
      badges.push({ label: ref, kind: "branch" });
    }
  }
  return badges;
}
