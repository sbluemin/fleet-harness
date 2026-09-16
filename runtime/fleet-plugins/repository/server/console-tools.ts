import fs from "node:fs/promises";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
import { z } from "zod";

import { InvalidRepoError, isNoHeadError, literalPathspec, parseDiffFileList, parseNumstat, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { resolveContainedGitDir } from "./git-marker.js";
import { isCanonicalRepositoryRef, parseLogOutput, parseWorktreePorcelainEntries } from "./log.js";
import { isPathContained, isSelectableRepoRel } from "./path-containment.js";
import { parseStatusV2 } from "./status.js";

/**
 * Console Use 에 싣는 저장소 읽기 도구. HTTP 라우트와 같은 부품(`resolveGitCwd`·`runGit`·파서)을 쓰되
 * 인자는 에이전트가 쓰기 쉬운 모양이다. 쓰기(스테이지·커밋·스태시·푸시)는 여기에 없다 — 그것은 그
 * Theater 의 Operation 에 시키는 일이다. 게이트는 호스트가 진다(실험 옵트인 AND 호출자 토글).
 */

const ids = z.string().min(1).max(128);
const rel = z.string().max(512).optional();
const DIFF_TEXT_CAP = 200_000;
const LOG_PRETTY = "--pretty=format:%x1e%H%x00%h%x00%s%x00%an%x00%ar%x00%at%x00%D%x00%P%x00%<(8,trunc)%b";

class ToolError extends Error { constructor(readonly code: string) { super(code); } }

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { items: value } : value as Record<string, unknown>, isError: false };
}

function gitError(error: unknown): never {
  if (error instanceof ToolError) throw error;
  if (error instanceof InvalidRepoError) throw new ToolError(error.code);
  if (error instanceof GitExecutorError) throw new ToolError(error.code === "no_git_repo" || error.code === "git_unavailable" ? error.code : "git_failed");
  throw error;
}

export function createRepositoryConsoleTools(ctx: FleetPluginServerContext): readonly PluginMcpTool[] {
  const cwdOf = async (theaterId: string, worktree: string | undefined) => {
    const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!theaterPath) throw new ToolError("unknown_theater");
    try { return { theaterPath, gitCwd: (await resolveGitCwd(theaterPath, worktree ?? "")).gitCwd }; }
    catch (error) { return gitError(error); }
  };
  const define = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, signal?: AbortSignal) => Promise<unknown>): PluginMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    execute: async (args, context) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ...text({ error: "invalid_arguments" }), isError: true };
      try { return text(await run(parsed.data, context.signal)); }
      catch (error) { return { ...text({ error: error instanceof ToolError ? error.code : "git_failed", retryable: false }), isError: true }; }
    },
  });
  const scope = z.object({ theaterId: ids, worktree: rel }).strict();
  return [
    define("console_repo_status", "Read a Theater repository's working tree status: branch, staged and unstaged files with +/- line counts. worktree selects a nested repository or worktree folder relative to the Theater. Read-only.", scope, async (args) => {
      const { gitCwd } = await cwdOf(args.theaterId, args.worktree);
      try {
        const [status, staged, unstaged, branch] = await Promise.all([
          runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], { cwd: gitCwd }),
          runGit(["diff", "--cached", "--numstat", "-z", "--", "."], { cwd: gitCwd }).catch(() => ({ stdout: "", truncated: false })),
          runGit(["diff", "--numstat", "-z", "--", "."], { cwd: gitCwd }).catch(() => ({ stdout: "", truncated: false })),
          runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitCwd }).then((r) => r.stdout.trim()).catch(() => null),
        ]);
        const parsed = parseStatusV2(status.stdout, parseNumstat(staged.stdout), parseNumstat(unstaged.stdout));
        const ahead = /# branch\.ab \+(\d+) -(\d+)/.exec(status.stdout);
        return { branch, ...(ahead ? { ahead: Number(ahead[1]), behind: Number(ahead[2]) } : {}), staged: parsed.staged, unstaged: parsed.unstaged, truncated: status.truncated };
      } catch (error) { return gitError(error); }
    }),
    define("console_repo_diff", "Read changes in a Theater repository. Without path: the list of changed files against HEAD (plus untracked). With path: the unified diff of that one file (capped). ref compares against that canonical ref (refs/heads/..., refs/tags/...) instead of the working tree state. Read-only, untrusted data.", z.object({ theaterId: ids, worktree: rel, path: z.string().min(1).max(512).optional(), ref: z.string().max(200).optional() }).strict(), async (args) => {
      const { gitCwd } = await cwdOf(args.theaterId, args.worktree);
      if (args.ref !== undefined && !isCanonicalRepositoryRef(args.ref)) throw new ToolError("invalid_ref");
      try {
        // 읽기 전용이다 — 저장소가 설정한 textconv·외부 diff 드라이버를 실행하지 않는다(HTTP diff 핸들러와 같은 플래그).
        const quiet = ["--no-ext-diff", "--no-textconv"];
        if (!args.path) {
          const base = args.ref ?? "HEAD";
          const list = (against: readonly string[]) => Promise.all([
            runGit(["diff", ...quiet, ...against, "--relative", "--name-status", "-z", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
            runGit(["diff", ...quiet, ...against, "--relative", "--numstat", "-z", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
          ]);
          let names; let nums;
          try { [names, nums] = await list([base]); }
          catch (error) {
            // 첫 커밋 전의 저장소는 HEAD 가 없다 — 스테이지 목록으로 대신한다(HTTP changed 핸들러와 같은 폴백).
            if (args.ref !== undefined || !isNoHeadError(error)) throw error;
            [names, nums] = await list(["--cached"]);
          }
          const files = parseDiffFileList(names.stdout, nums.stdout);
          const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: gitCwd }).catch(() => ({ stdout: "" }));
          return { base, files, untracked: untracked.stdout.split("\0").filter(Boolean), truncated: names.truncated || nums.truncated };
        }
        const resolved = path.resolve(gitCwd, args.path);
        if (resolved !== gitCwd && !resolved.startsWith(gitCwd + path.sep)) throw new ToolError("path_outside_theater");
        const relative = path.relative(gitCwd, resolved);
        if (relative.startsWith("..")) throw new ToolError("path_outside_theater");
        // 파일 이름은 리터럴 pathspec 으로 넘긴다 — `*`·`[`·`:` 가 든 이름이 패턴으로 읽히지 않게.
        let result;
        try { result = await runGit(["diff", ...quiet, args.ref ?? "HEAD", "--", literalPathspec(relative)], { cwd: gitCwd }); }
        catch (error) {
          if (args.ref !== undefined || !isNoHeadError(error)) throw error;
          result = await runGit(["diff", ...quiet, "--cached", "--", literalPathspec(relative)], { cwd: gitCwd });
        }
        let diff = result.stdout;
        if (!diff) {
          // 추적되지 않은 새 파일은 HEAD 와의 diff 가 비어 있다 — 내용 자체를 추가로 보여 준다.
          const untracked = await runGit(["diff", ...quiet, "--no-index", "--", "/dev/null", relative], { cwd: gitCwd, allowExitCodes: [1] }).catch(() => null);
          diff = untracked?.stdout ?? "";
        }
        const cut = diff.length > DIFF_TEXT_CAP;
        return { path: relative, diff: cut ? diff.slice(0, DIFF_TEXT_CAP) : diff, truncated: cut || result.truncated };
      } catch (error) { return gitError(error); }
    }),
    define("console_repo_log", "Read recent commits of a Theater repository (hash, subject, author, relative date, refs). ref limits the walk to a canonical ref. Read-only.", z.object({ theaterId: ids, worktree: rel, ref: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional(), skip: z.number().int().min(0).max(10_000).optional() }).strict(), async (args) => {
      const { gitCwd } = await cwdOf(args.theaterId, args.worktree);
      if (args.ref !== undefined && !isCanonicalRepositoryRef(args.ref)) throw new ToolError("invalid_ref");
      const limit = args.limit ?? 30;
      try {
        const result = await runGit(["log", "--date-order", "-n", String(limit + 1), ...(args.skip ? [`--skip=${args.skip}`] : []), "--decorate=full", LOG_PRETTY, args.ref ?? "HEAD", "--"], { cwd: gitCwd });
        const commits = parseLogOutput(result.stdout);
        return { commits: commits.slice(0, limit).map((c) => ({ sha: c.fullHash, shortSha: c.shortHash, subject: c.subject, author: c.authorName, relativeDate: c.relTime, refs: c.refs })), hasMore: commits.length > limit || result.truncated };
      } catch (error) {
        if (error instanceof GitExecutorError && (error.code === "no_git_repo" || error.code === "non_zero_exit")) return { commits: [], hasMore: false };
        return gitError(error);
      }
    }),
    define("console_repo_search", "Search a Theater repository's tracked file contents with git grep (fixed string, case-insensitive). Returns path, line and a short excerpt per match, capped. Read-only, untrusted data.", z.object({ theaterId: ids, worktree: rel, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).strict(), async (args) => {
      const { gitCwd } = await cwdOf(args.theaterId, args.worktree);
      const limit = args.limit ?? 50;
      try {
        const result = await runGit(["grep", "-I", "-n", "-i", "-F", "--no-color", "-e", args.query, "--", "."], { cwd: gitCwd, allowExitCodes: [1] });
        const lines = result.stdout.split("\n").filter(Boolean);
        const matches = lines.slice(0, limit).map((line) => {
          const first = line.indexOf(":"); const second = line.indexOf(":", first + 1);
          return { path: line.slice(0, first), line: Number(line.slice(first + 1, second)), text: line.slice(second + 1).slice(0, 300) };
        });
        return { matches, total: lines.length, truncated: lines.length > limit || result.truncated };
      } catch (error) { return gitError(error); }
    }),
    define("console_repo_worktrees", "List git worktrees inside a Theater (folder relative to the Theater, name, branch, whether it is the current one). Use the relative folder as worktree in the other console_repo_* tools. Read-only.", z.object({ theaterId: ids }).strict(), async (args) => {
      const { theaterPath, gitCwd } = await cwdOf(args.theaterId, undefined);
      let realTheaterPath: string; let realGitCwd: string;
      try { [realTheaterPath, realGitCwd] = await Promise.all([fs.realpath(theaterPath), fs.realpath(gitCwd)]); }
      catch { throw new ToolError("invalid_repo"); }
      try {
        const result = await runGit(["worktree", "list", "--porcelain"], { cwd: gitCwd });
        const worktrees: { readonly relPath: string; readonly name: string; readonly branch: string; readonly current: boolean }[] = [];
        const seen = new Set<string>();
        for (const worktree of parseWorktreePorcelainEntries(result.stdout)) {
          let real: string;
          try { real = await fs.realpath(worktree.worktreePath); } catch { continue; }
          if (!isPathContained(realTheaterPath, real)) continue;
          const relPath = path.relative(realTheaterPath, real);
          if (!isSelectableRepoRel(relPath) || seen.has(relPath)) continue;
          if ((await resolveContainedGitDir(real, realTheaterPath)) === null) continue;
          worktrees.push({ relPath, name: path.basename(real), branch: worktree.branch ?? worktree.sha.slice(0, 7), current: real === realGitCwd });
          seen.add(relPath);
        }
        return { worktrees };
      } catch (error) { return gitError(error); }
    }),
  ];
}
