import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export class ClaudeTrustError extends Error {
  constructor(readonly code: "claude_trust_unavailable" | "claude_trust_invalid_config" | "claude_trust_write_failed" | "claude_trust_locked") {
    super(code);
  }
}

async function selectedConfigPath(): Promise<string> {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const legacy = path.join(configured || path.join(os.homedir(), ".claude"), ".config.json");
  try {
    await fs.lstat(legacy);
    return legacy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ClaudeTrustError("claude_trust_unavailable");
  }
  const oauth = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  // 알려지지 않은 CLI 인증 환경에서는 기본 설정 파일을 잘못 신뢰시키지 않는다.
  if (oauth && !["https://claude.fedstart.com", "https://claude-staging.fedstart.com"].includes(oauth.replace(/\/$/, ""))) {
    throw new ClaudeTrustError("claude_trust_unavailable");
  }
  return path.join(configured || os.homedir(), oauth ? ".claude-custom-oauth.json" : ".claude.json");
}

type Settings = Record<string, unknown>;
function object(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSettings(file: string): Promise<{ settings: Settings; original: string | null; mode: number }> {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.nlink !== 1) throw new ClaudeTrustError("claude_trust_unavailable");
    const original = await fs.readFile(file, "utf8");
    const settings: unknown = JSON.parse(original);
    if (!object(settings) || (settings.projects !== undefined && !object(settings.projects))) throw new ClaudeTrustError("claude_trust_invalid_config");
    return { settings, original, mode: info.mode & 0o777 };
  } catch (error) {
    if (error instanceof SyntaxError) throw new ClaudeTrustError("claude_trust_invalid_config");
    if (error instanceof ClaudeTrustError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, original: null, mode: 0o600 };
    throw new ClaudeTrustError("claude_trust_unavailable");
  }
}

function projectKey(cwd: string): string {
  const normalized = path.normalize(cwd).normalize("NFC");
  return process.platform === "win32" ? normalized.replace(/\\/g, "/") : normalized;
}

async function gitBoundary(cwd: string): Promise<{ root: string; mainRoot: string | null }> {
  for (let current = cwd; ; current = path.dirname(current)) {
    const dotGit = path.join(current, ".git");
    try {
      const entry = await fs.lstat(dotGit);
      let info = entry;
      if (entry.isSymbolicLink()) {
        try { info = await fs.stat(dotGit); }
        catch { return { root: current, mainRoot: null }; }
      }
      if (info.isDirectory()) return { root: current, mainRoot: current };
      if (!info.isFile()) return { root: current, mainRoot: null };
      const match = /^gitdir: (.+)\s*$/m.exec(await fs.readFile(dotGit, "utf8"));
      if (!match) return { root: current, mainRoot: null };
      const gitDir = path.resolve(current, match[1]!.trim());
      try {
        const common = path.resolve(gitDir, (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim());
        const backlink = (await fs.readFile(path.join(gitDir, "gitdir"), "utf8")).trim();
        if (path.dirname(gitDir) !== path.join(common, "worktrees")
          || await fs.realpath(path.resolve(gitDir, backlink)) !== await fs.realpath(dotGit)) {
          return { root: current, mainRoot: null };
        }
        if (path.basename(common) === ".git") return { root: current, mainRoot: path.dirname(common) };
        try { await fs.stat(path.join(common, ".git")); return { root: current, mainRoot: null }; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { root: current, mainRoot: null };
        }
        return { root: current, mainRoot: common };
      } catch { return { root: current, mainRoot: null }; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { root: current, mainRoot: null };
    }
    if (current === path.dirname(current)) return { root: current, mainRoot: null };
  }
}

async function isTrusted(settings: Settings, cwd: string): Promise<boolean> {
  const projects = settings.projects;
  if (!object(projects)) return false;
  const { root, mainRoot } = await gitBoundary(cwd);
  const mainProject = mainRoot ? projects[projectKey(mainRoot)] : undefined;
  if (object(mainProject) && mainProject.hasTrustDialogAccepted === true) return true;
  for (let current = cwd; ; current = path.dirname(current)) {
    const project = projects[projectKey(current)];
    if (object(project) && project.hasTrustDialogAccepted === true) return true;
    if (current === root || current === path.dirname(current)) break;
  }
  return false;
}

/** 실행 직전에도 조회한다. 확인되지 않은 경로에는 자동 프롬프트를 보내지 않는다. */
export async function isClaudePathTrusted(cwd: string): Promise<boolean> {
  try {
    const real = await fs.realpath(cwd);
    return await isTrusted((await readSettings(await selectedConfigPath())).settings, real);
  } catch {
    return false;
  }
}

/** 사용자가 Theater 추가 안내에 동의한 경우에만 호출한다. */
export async function trustClaudeTheater(cwd: string): Promise<void> {
  const real = await fs.realpath(cwd);
  const selected = await selectedConfigPath();
  let file: string;
  try {
    await fs.mkdir(path.dirname(selected), { recursive: true, mode: 0o700 });
    // CLI는 선택된 설정 파일 경로에 .lock을 붙여 잠근다. 실제 쓰기 대상은 symlink의 realpath다.
    try { file = await fs.realpath(selected); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      file = path.join(await fs.realpath(path.dirname(selected)), path.basename(selected));
    }
  } catch { throw new ClaudeTrustError("claude_trust_unavailable"); }
  const lock = `${selected}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 30 && !locked; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); locked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ClaudeTrustError("claude_trust_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!locked) throw new ClaudeTrustError("claude_trust_locked");
  const owned = await fs.stat(lock);
  const ownsLock = async () => {
    try { const current = await fs.stat(lock); return current.dev === owned.dev && current.ino === owned.ino; }
    catch { return false; }
  };
  // CLI proper-lockfile의 stale(10초)보다 짧게 mtime을 갱신한다. 기존 잠금은 훔치지 않는다.
  const heartbeat = setInterval(() => { void (async () => {
    if (await ownsLock()) await fs.utimes(lock, new Date(), new Date());
  })().catch(() => {}); }, 1_000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { settings, original, mode } = await readSettings(file);
      if (await isTrusted(settings, real)) return;
      const projects = object(settings.projects) ? settings.projects : {};
      const key = projectKey(real);
      const project = projects[key];
      if (project !== undefined && !object(project)) throw new ClaudeTrustError("claude_trust_invalid_config");
      const next = { ...settings, projects: { ...projects, [key]: { ...(object(project) ? project : {}), hasTrustDialogAccepted: true } } };
      const temp = `${file}.fleet-${randomUUID()}`;
      try {
        const handle = await fs.open(temp, "wx", mode);
        try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        // CLI는 Fleet의 잠금을 공유하지 않는다. 교체 직전 재조회로 관찰된 외부 갱신은 병합한다.
        if (!await ownsLock()) throw new ClaudeTrustError("claude_trust_write_failed");
        if ((await readSettings(file)).original !== original) continue;
        if (!await ownsLock()) throw new ClaudeTrustError("claude_trust_write_failed");
        await fs.rename(temp, file);
        // Windows에서는 디렉터리 핸들의 fsync가 지원되지 않는다. 파일 자체의 sync는 이미 마쳤다.
        if (process.platform !== "win32") {
          const dir = await fs.open(path.dirname(file), "r");
          try { await dir.sync(); } finally { await dir.close(); }
        }
        if (await isClaudePathTrusted(real)) return;
      } catch (error) {
        if (error instanceof ClaudeTrustError) throw error;
        throw new ClaudeTrustError("claude_trust_write_failed");
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }
    throw new ClaudeTrustError("claude_trust_write_failed");
  } finally {
    clearInterval(heartbeat);
    if (await ownsLock()) await fs.rmdir(lock).catch(() => {});
  }
}
