import type { SkillSearchItem } from "./types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_SKILLS_API_URL = "https://skills.sh";
const FETCH_TIMEOUT_MS = 8000;
const MAX_LIMIT = 20;

// ─── functions ───────────────────────────────────────────────────────────────

function getApiBaseUrl(): string {
  const override = process.env["SKILLS_API_URL"];
  if (!override) return DEFAULT_SKILLS_API_URL;
  // 오버라이드는 미러/로컬 스텁용 — http(s) 외 스킴(file:, ftp: 등)은 기본값으로 폴백한다.
  try {
    const parsed = new URL(override);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return override;
  } catch {
    // 파싱 불가 → 폴백
  }
  return DEFAULT_SKILLS_API_URL;
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
  const clampedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
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
