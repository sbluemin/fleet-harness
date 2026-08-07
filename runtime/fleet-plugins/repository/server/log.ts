import fs from "node:fs/promises";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { LogCommitEntry, LogOrder, WorktreeCheckout } from "./types.js";
import { InvalidRepoError, resolveGitCwd } from "./diff.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface ParsedWorktree {
  readonly sha: string;
  readonly branch: string | null;
  readonly worktreePath: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

// porcelain HEAD 라인에서 파싱된 값만 rev 인자로 허용하는 방어 검증
const WORKTREE_SHA_RE = /^[0-9a-f]{40}$/;
const CANONICAL_REF_RE = /^refs\/(?:heads|remotes|tags)\//;
// gitrevisions 선택자(@{n}·^·~ 등)와 check-ref-format 금지 문자를 이름 수준에서 거부한다 —
// rev-parse가 reflog/조상 표현식을 해석해 /refs 열거 밖 커밋으로 필터되는 것을 막는다
const REF_METACHAR_RE = /[~^:?*\[\\\s\x00-\x1f\x7f]/;

// 본문은 존재 여부만 필요하므로 %b를 8칸으로 절단해 싣는다. 평범한 저장소에서 페이지 페이로드를 크게 줄이고
// (실측: 400KB 본문 6커밋이 2.4MB → 1KB), 절단본은 한 줄로 눌려 뒤 필드를 다음 줄로 밀지도 않는다.
// 다만 이 절단은 페이지 크기의 안전장치가 아니다 — 폭은 바이트가 아니라 표시 칸이라 폭 0인 문자에는 걸리지 않고,
// %s·%D도 똑같이 바이트 상한이 없다. 버퍼가 잘렸을 때의 안전은 hasMore 판정이 진다(핸들러 참조).
// 알려진 한계: 본문이 공백 8칸으로 시작하면 존재 여부가 false로 읽힌다 — 마커 한 개가 빠질 뿐이다.
const LOG_PRETTY_FORMAT = "--pretty=format:%x1e%H%x00%h%x00%s%x00%an%x00%ar%x00%at%x00%D%x00%P%x00%<(8,trunc)%b";

// 정렬 축은 화이트리스트 상수로만 git 인자가 된다 — 요청 문자열이 인자 위치에 직접 닿지 않게 한다.
const LOG_ORDER_ARGS: Readonly<Record<LogOrder, string>> = { topo: "--topo-order", date: "--date-order" };

export function resolveLogOrder(requested: unknown): LogOrder | null {
  if (requested === undefined) return "topo";
  return requested === "topo" || requested === "date" ? requested : null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCanonicalRepositoryRef(ref: string): boolean {
  return CANONICAL_REF_RE.test(ref)
    && !ref.startsWith("-")
    && !ref.includes("..")
    && !ref.includes("//")
    && !REF_METACHAR_RE.test(ref)
    && !ref.includes("@{")
    && !ref.endsWith("/")
    && !ref.endsWith(".")
    && !ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

export function parseLogOutput(stdout: string): LogCommitEntry[] {
  if (!stdout.trim()) return [];
  const commits: LogCommitEntry[] = [];

  for (const chunk of stdout.split("\x1e")) {
    const trimmed = chunk.trimStart();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const firstLine = lines[0] ?? "";
    const fields = firstLine.split("\x00");

    const fullHash = fields[0] ?? "";
    const shortHash = fields[1] ?? "";
    const subject = fields[2] ?? "";
    const authorName = fields[3] ?? "";
    const relTime = fields[4] ?? "";
    const authorAt = Number.parseInt(fields[5] ?? "0", 10);
    const refsRaw = fields[6] ?? "";
    const parentsRaw = fields[7] ?? "";

    if (!fullHash) continue;

    const refs = refsRaw.split(",").map((r) => r.trim()).filter(Boolean);
    const parents = parentsRaw.split(" ").map((p) => p.trim()).filter(Boolean);
    // 본문 필드는 8칸으로 절단되어 한 줄에 들어오므로 첫 줄의 9번째 조각만 보면 된다.
    // 빈 본문은 공백으로 채워져 오고, 내용이 있으면 잘린 앞부분이 온다 — 존재 여부만 남기고 내용은 버린다.
    const hasBody = (fields[8] ?? "").trim() !== "";

    commits.push({
      shortHash,
      fullHash,
      subject,
      authorName,
      relTime,
      authorAt: Number.isFinite(authorAt) ? authorAt : 0,
      refs,
      parents,
      onHead: true,
      hasBody,
    });
  }

  return commits;
}

export function parseWorktreePorcelainEntries(stdout: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let worktreePath: string | null = null;
  let sha = "";
  let branch: string | null = null;
  let prunable = false;

  const pushCurrent = () => {
    // unborn(orphan) 체크아웃은 zero-SHA placeholder라 커밋 체크아웃이 아니고,
    // prunable 레코드는 디렉터리가 사라진 stale 워크트리라 활성 체크아웃이 아니다
    if (!worktreePath || !sha || prunable || /^0+$/.test(sha)) return;
    worktrees.push({
      sha,
      branch,
      worktreePath,
    });
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      pushCurrent();
      worktreePath = line.slice(9);
      sha = "";
      branch = null;
      prunable = false;
    } else if (line.startsWith("HEAD ")) {
      sha = line.slice(5);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice(7);
      branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      prunable = true;
    }
  }
  pushCurrent();

  return worktrees;
}

export async function parseWorktreePorcelain(stdout: string, currentWorktreePath: string): Promise<WorktreeCheckout[]> {
  const worktrees = parseWorktreePorcelainEntries(stdout);

  const normalizedCurrentWorktreePath = await normalizeWorktreePath(currentWorktreePath);
  return Promise.all(worktrees.map(async ({ worktreePath, ...checkout }) => ({
    ...checkout,
    isCurrent: normalizedCurrentWorktreePath !== ""
      && (await normalizeWorktreePath(worktreePath)) === normalizedCurrentWorktreePath,
  })));
}

export function annotateHeadReachability(commits: LogCommitEntry[], revListStdout: string): LogCommitEntry[] {
  const reachable = new Set(revListStdout.split("\n").map((line) => line.trim()).filter(Boolean));
  // rev-list 실패/빈 결과(HEAD 부재 등)에서는 전체 dim을 피하기 위해 모두 도달 가능으로 둔다
  if (reachable.size === 0) return commits;
  return commits.map((commit) => ({ ...commit, onHead: reachable.has(commit.fullHash) }));
}

function isNoHeadError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision")
    || error.stderr.includes("bad revision")
    // 명시 rev 없이 --branches만으로 도는 빈 저장소는 이 메시지로 실패한다
    || error.stderr.includes("does not have any commits");
}

async function normalizeWorktreePath(worktreePath: string): Promise<string> {
  if (!worktreePath) return "";
  try {
    return await fs.realpath(worktreePath);
  } catch {
    return worktreePath;
  }
}

async function readHeadRevList(gitCwd: string, skip: number, limit: number): Promise<string> {
  try {
    // 현재 페이지 끝보다 800개 더 읽되 최소 1000개를 유지해, 누적 표시 윈도 밖의
    // 분기 커밋까지 HEAD 도달성 판정에 충분한 여유를 둔다.
    return (await runGit(["rev-list", "-n", String(Math.max(1000, skip + limit + 800)), "HEAD"], { cwd: gitCwd })).stdout;
  } catch (error) {
    if (error instanceof GitExecutorError) return "";
    throw error;
  }
}

async function readCurrentWorktreePath(gitCwd: string): Promise<string> {
  try {
    return (await runGit(["rev-parse", "--show-toplevel"], { cwd: gitCwd })).stdout.trim();
  } catch (error) {
    if (error instanceof GitExecutorError) return "";
    throw error;
  }
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleRepositoryLog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown; readonly ref?: unknown; readonly limit?: unknown; readonly skip?: unknown; readonly order?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const order = resolveLogOrder(body.order);
  if (order === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const limit = body.limit === undefined ? 200 : body.limit;
  const skip = body.skip === undefined ? 0 : body.skip;
  if (!Number.isInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 500
    || !Number.isInteger(skip) || typeof skip !== "number" || skip < 0) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let cwdResult: { gitCwd: string };
  try { cwdResult = await resolveGitCwd(theaterPath, body.repoRel); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
  const { gitCwd } = cwdResult;

  const requestedRef = body.ref;
  if (requestedRef !== undefined && (typeof requestedRef !== "string" || !isCanonicalRepositoryRef(requestedRef))) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_ref" }); return;
  }

  try {
    const resolvedRef = typeof requestedRef === "string"
      ? (await runGit(["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`], { cwd: gitCwd })).stdout.trim()
      : null;
    const [worktrees, currentWorktreePath, headRevList] = await Promise.all([
      runGit(["worktree", "list", "--porcelain"], { cwd: gitCwd }),
      readCurrentWorktreePath(gitCwd),
      readHeadRevList(gitCwd, skip, limit),
    ]);
    const checkouts = await parseWorktreePorcelain(worktrees.stdout, currentWorktreePath);
    // detached 워크트리 HEAD는 어떤 브랜치/태그/원격에서도 도달 불가능할 수 있으므로 rev 집합에 명시적으로 추가한다
    const worktreeRevs = [...new Set(checkouts.map((checkout) => checkout.sha))]
      // orphan 워크트리의 unborn HEAD는 zero-SHA로 보고되며 rev 인자로 넘기면 로그 전체가 실패한다
      .filter((sha) => WORKTREE_SHA_RE.test(sha) && !/^0+$/.test(sha));
    // unborn(orphan) 체크아웃에서는 명시 HEAD 인자가 로그 전체를 실패시키므로 rev-list 성공 여부로 게이트한다
    const headRevs = headRevList ? ["HEAD"] : [];
    // Theater가 저장소 루트가 아니면(더 큰 워크트리의 하위 디렉터리) pathspec이 Theater 스코프를 지탱하므로 유지한다.
    // 루트일 때만 생략한다 — pathspec이 붙으면 git 기본 history simplification이 TREESAME 커밋(변경 없는 빈 커밋 등)을
    // 목록에서 지우는데 %P는 원본 부모를 그대로 뱉어, 클라이언트 레인 매칭이 끊기고 없는 분기가 그려지기 때문이다.
    // 생략하는 쪽에서도 "--" 종결자는 남긴다 — 없으면 'HEAD'라는 이름의 파일이 있는 저장소에서
    // rev/경로 모호성으로 로그 전체가 실패한다.
    const [realGitCwd, realToplevel] = await Promise.all([normalizeWorktreePath(gitCwd), normalizeWorktreePath(currentWorktreePath)]);
    const scopePathspec = realToplevel !== "" && realGitCwd === realToplevel ? [] : ["."];
    const skipArg = skip > 0 ? [`--skip=${skip}`] : [];
    const orderArg = LOG_ORDER_ARGS[order];
    const result = resolvedRef
      ? await runGit(["log", resolvedRef, orderArg, "-n", String(limit + 1), ...skipArg, "--decorate=full", LOG_PRETTY_FORMAT, "--", ...scopePathspec], { cwd: gitCwd })
      : await runGit(
        // --all은 refs/stash·refs/notes까지 그래프에 유입시키므로 브랜치/태그/원격 + 현재 HEAD + 워크트리 HEAD로 한정한다
        ["log", "--branches", "--tags", "--remotes", orderArg, "-n", String(limit + 1), ...skipArg, "--decorate=full", LOG_PRETTY_FORMAT, ...headRevs, ...worktreeRevs, "--", ...scopePathspec],
        { cwd: gitCwd },
      );
    const parsedCommits = parseLogOutput(result.stdout);
    // stdout이 잘렸다면 레코드 수는 "더 없음"의 근거가 되지 못한다 — 잘린 지점 이후를 못 읽었을 뿐이다.
    // 이때도 개수로 판정하면 hasMore가 false로 접혀 남은 이력이 페이지네이션에서 통째로 사라진다.
    // 페이지 크기를 포맷으로 묶어 막을 수는 없다: %s·%D·%b는 모두 사용자 작성 텍스트라 바이트 상한이 없고,
    // pretty-format의 절단 폭은 바이트가 아니라 표시 칸이라 폭 0인 문자에는 걸리지 않는다.
    // 레코드를 하나도 못 읽었을 때는 열어 두지 않는다 — skip이 전진하지 못해 더 보기가 헛도는 쪽이 더 나쁘다.
    const hasMore = parsedCommits.length > limit || (result.truncated && parsedCommits.length > 0);
    const commits = annotateHeadReachability(parsedCommits.slice(0, limit), headRevList);
    ctx.host.http.writeJson(res, 200, { commits, checkouts, hasMore, ...(result.truncated ? { truncated: true } : {}) });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (requestedRef !== undefined && error.code === "non_zero_exit") {
        ctx.host.http.writeJson(res, 400, { error: "invalid_ref" });
        return;
      }
      if (error.code === "no_git_repo") {
        ctx.host.http.writeJson(res, 200, { commits: [], checkouts: [], hasMore: false });
        return;
      }
      if (error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      // no-HEAD 신규 저장소(HEAD 미존재)는 빈 배열 graceful; 그 외 비정상 종료는 500 — 500 분기보다 먼저 검사한다
      if (isNoHeadError(error)) {
        ctx.host.http.writeJson(res, 200, { commits: [], checkouts: [], hasMore: false });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
