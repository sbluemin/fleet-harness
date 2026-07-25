import type {
  TheaterRowBadge,
  TheaterRowBadgeContribution,
  TheaterRowBadgeProvider,
} from "@fleet-console/sdk/plugin";

import { runGit, type GitRunResult } from "./git-executor.js";

const STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"] as const;

type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd: string; readonly signal?: AbortSignal },
) => Promise<GitRunResult>;

interface RepositoryStatus {
  readonly oid: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly changed: number;
}

export function createRepositoryRowBadgeProvider(
  resolveTheaterPath: (theaterId: string) => string | null,
  executeGit: GitRunner = runGit,
): TheaterRowBadgeProvider {
  return async ({ theaterIds, signal }) => {
    const contributions = await Promise.all(theaterIds.map(async (theaterId): Promise<TheaterRowBadgeContribution | null> => {
      const cwd = resolveTheaterPath(theaterId);
      if (!cwd || signal.aborted) return null;
      try {
        const result = await executeGit(STATUS_ARGS, { cwd, signal });
        if (signal.aborted) return null;
        return { theaterId, badges: statusBadges(parsePorcelainV2Status(result.stdout)) };
      } catch {
        return null;
      }
    }));
    return contributions.filter((contribution): contribution is TheaterRowBadgeContribution => contribution !== null);
  };
}

export function parsePorcelainV2Status(stdout: string): RepositoryStatus {
  let oid: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  const records = stdout.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      oid = record.slice("# branch.oid ".length);
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      head = record.slice("# branch.head ".length);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("2 ")) {
      changed += 1;
      index += 1;
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("u ") || record.startsWith("? ")) {
      changed += 1;
    }
  }

  return { oid, head, upstream, ahead, behind, changed };
}

export function statusBadges(status: RepositoryStatus): readonly TheaterRowBadge[] {
  const branch = status.head === "(detached)"
    ? status.oid?.slice(0, 7) ?? "detached"
    : status.head ?? status.oid?.slice(0, 7) ?? "unknown";
  const badges: TheaterRowBadge[] = [
    { id: "branch", text: branch, tone: "neutral" },
    status.changed > 0
      ? { id: "changed", text: `${status.changed} changed`, tone: "warn" }
      : { id: "changed", text: "clean", tone: "positive" },
  ];
  if (status.upstream && status.ahead > 0) badges.push({ id: "ahead", text: `↑${status.ahead}`, tone: "info" });
  if (status.upstream && status.behind > 0) badges.push({ id: "behind", text: `↓${status.behind}`, tone: "info" });
  return badges;
}
