import fs from "node:fs";
import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";

export interface LegacyKnowledgeSource { readonly path: string; readonly label: string }

/**
 * 사령관 이전 시절의 Wiki는 cwd 실경로를 키로 한 workspace 디렉터리(`workspaces/<이름>/knowledge`)에 있었다.
 * 그 옛 키를 사령관에 대응시키는 곳은 이 파일 하나이고, 쓰임은 사령관 지식으로 한 번 옮기는 이주뿐이다 —
 * 런타임 위치 해석은 사령관 id만 본다. 연결 경로 하나당 그 경로가 직접 소유한 workspace만 센다(현재 이름 → 옛 이름 순).
 * 다른 cwd(worktree 등)의 workspace는 세지 않는다. 아무것도 만들지 않는다.
 */
export function legacyKnowledgeSources(consoleDataDir: string, theaterPaths: readonly string[]): LegacyKnowledgeSource[] {
  const sources: LegacyKnowledgeSource[] = [];
  const seen = new Set<string>();
  for (const theaterPath of theaterPaths) {
    for (const name of workspaceDirectoryNames(theaterPath)) {
      const workspace = path.join(consoleDataDir, "workspaces", name);
      if (seen.has(workspace) || !ownedWorkspace(workspace, theaterPath)) continue;
      seen.add(workspace);
      const knowledge = path.join(workspace, "knowledge");
      if (exists(knowledge)) sources.push({ path: knowledge, label: name });
    }
  }
  return sources;
}

/** 옮길 내용이 있을 수 있는가 — 기동 시 사령관이 없는 경로에 사령관을 발급할지 가르는 값싼 검사다. */
export function hasLegacyKnowledge(consoleDataDir: string, theaterPath: string): boolean {
  return legacyKnowledgeSources(consoleDataDir, [theaterPath]).some((source) => {
    try { return fs.readdirSync(source.path).length > 0; } catch { return true; }
  });
}

function ownedWorkspace(workspace: string, theaterPath: string): boolean {
  try {
    const stat = fs.lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const identity = path.join(workspace, "cwd.json");
    const identityStat = fs.lstatSync(identity);
    if (!identityStat.isFile() || identityStat.isSymbolicLink()) return false;
    const value = JSON.parse(fs.readFileSync(identity, "utf8")) as { cwd?: unknown };
    return value.cwd === theaterPath;
  } catch { return false; }
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
