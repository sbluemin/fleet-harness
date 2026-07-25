import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import type { LogCommitEntry } from "../server/types.js";
import { getT } from "./i18n/index.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type RefBadgeKind = "head" | "tag" | "branch" | "remote" | "worktree";

export interface RefBadge {
  readonly label: string;
  readonly kind: RefBadgeKind;
}

// ─── functions ───────────────────────────────────────────────────────────────

export function formatCommitTime(authorAt: number, now = new Date(), locale: ConsoleLocale | undefined = "en"): string {
  const date = new Date(authorAt * 1000);
  if (!Number.isFinite(date.getTime())) return "—";

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfCommit = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((startOfToday - startOfCommit) / 86_400_000);
  const t = getT(locale);

  if (dayOffset === 0) return t("repository.time.today", { time });
  if (dayOffset === 1) return t("repository.time.yesterday", { time });
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function refBadges(entry: LogCommitEntry): RefBadge[] {
  const badges: RefBadge[] = [];
  for (const ref of entry.refs) {
    if (ref === "HEAD") {
      badges.push({ label: "HEAD", kind: "head" });
    } else if (ref.startsWith("HEAD -> refs/heads/")) {
      badges.push({ label: ref.slice("HEAD -> refs/heads/".length), kind: "branch" });
    } else if (ref.startsWith("HEAD -> ")) {
      badges.push({ label: ref.slice(8), kind: "branch" });
    } else if (ref.startsWith("tag: refs/tags/")) {
      badges.push({ label: ref.slice("tag: refs/tags/".length), kind: "tag" });
    } else if (ref.startsWith("tag: ")) {
      badges.push({ label: ref.slice(5), kind: "tag" });
    } else if (ref.startsWith("refs/remotes/")) {
      const label = ref.slice(13);
      // origin/HEAD 심볼릭 ref는 기본 브랜치 칩과 중복이므로 표시하지 않는다
      if (!label.endsWith("/HEAD")) badges.push({ label, kind: "remote" });
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
