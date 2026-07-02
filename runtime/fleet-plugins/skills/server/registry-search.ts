import type { SkillSearchItem } from "./types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_SKILLS_API_URL = "https://skills.sh";
const FETCH_TIMEOUT_MS = 8000;
const MAX_LIMIT = 20;

// ─── functions ───────────────────────────────────────────────────────────────

function getApiBaseUrl(): string {
  return process.env["SKILLS_API_URL"] ?? DEFAULT_SKILLS_API_URL;
}

function formatItem(raw: Record<string, unknown>): SkillSearchItem | null {
  const id = raw["id"];
  const name = raw["name"];
  const source = raw["source"] ?? raw["skillId"];
  const installs = raw["installs"];
  if (typeof id !== "string" || typeof name !== "string" || typeof source !== "string") {
    return null;
  }
  return {
    id,
    name,
    source,
    installs: typeof installs === "number" ? installs : 0,
  };
}

export async function searchRegistry(q: string, limit: number): Promise<SkillSearchItem[]> {
  const clampedLimit = Math.min(limit, MAX_LIMIT);
  const base = getApiBaseUrl();
  const url = `${base}/api/search?q=${encodeURIComponent(q)}&limit=${clampedLimit}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!res.ok) throw new Error(`registry_http_error: ${res.status}`);

  const data = await res.json() as Record<string, unknown>;
  const rawSkills = data["skills"];

  if (!Array.isArray(rawSkills)) return [];

  const items: SkillSearchItem[] = [];
  for (const raw of rawSkills) {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const item = formatItem(raw as Record<string, unknown>);
      if (item) items.push(item);
    }
  }
  return items;
}
