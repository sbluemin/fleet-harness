import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AgentSessionWorkspace } from "./types.js";

/**
 * Operation의 "지금 어디" 축 — 작업 폴더와 git 브랜치를 브라우저가 읽을 수 있는 투영으로 만든다.
 *
 * 절대 경로는 이 모듈 안에서 끝난다. 밖으로 나가는 것은 Theater 루트 기준 상대 폴더(루트면 null),
 * Theater 밖이면 basename 하나와 `outside` 표식, 그리고 브랜치 이름뿐이다. git은 셸 없이
 * 고정 인자로만 부르고 사용자 입력은 인자에 오르지 않는다.
 *
 * 옵트인 실험이다: `setEnabled(false)`인 동안은 git을 읽지도 HEAD를 감시하지도 않으며, 켜는 순간
 * 살아 있는 세션 전부를 한 번 계산하고 감시를 붙인다. 폴링은 없다 — 체크아웃이 `.git/HEAD`를
 * 바꿀 때만 다시 읽는다.
 */

export interface WorkspaceContextTrackerDeps {
  readonly resolveTheaterPath: (theaterId: string) => string | null;
  readonly onChange: (sessionId: string, workspace: AgentSessionWorkspace | null) => void;
  /** 테스트 대체용. 기본은 `git` 실행. */
  readonly readGit?: (args: readonly string[], cwd: string) => Promise<string | null>;
  readonly watch?: (target: string, listener: () => void) => (() => void) | null;
}

export interface WorkspaceContextTracker {
  setEnabled(enabled: boolean): void;
  /** 세션의 현재 cwd를 알린다. 같은 cwd면 아무 일도 하지 않는다. */
  observe(sessionId: string, theaterId: string, cwd: string): void;
  forget(sessionId: string): void;
  dispose(): void;
}

interface TrackedSession {
  readonly theaterId: string;
  cwd: string;
  generation: number;
  unwatch: (() => void) | null;
  debounce: ReturnType<typeof setTimeout> | null;
}

const HEAD_DEBOUNCE_MS = 120;
const GIT_TIMEOUT_MS = 3_000;

export function createWorkspaceContextTracker(deps: WorkspaceContextTrackerDeps): WorkspaceContextTracker {
  const readGit = deps.readGit ?? defaultReadGit;
  const watch = deps.watch ?? defaultWatch;
  const sessions = new Map<string, TrackedSession>();
  let enabled = false;

  function setEnabled(next: boolean): void {
    if (enabled === next) return;
    enabled = next;
    for (const [sessionId, tracked] of sessions) {
      if (next) void refresh(sessionId, tracked);
      else {
        stopWatching(tracked);
        deps.onChange(sessionId, null);
      }
    }
  }

  function observe(sessionId: string, theaterId: string, cwd: string): void {
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.cwd === cwd && existing.theaterId === theaterId) return;
      stopWatching(existing);
      existing.cwd = cwd;
      if (enabled) void refresh(sessionId, existing);
      return;
    }
    const tracked: TrackedSession = { theaterId, cwd, generation: 0, unwatch: null, debounce: null };
    sessions.set(sessionId, tracked);
    if (enabled) void refresh(sessionId, tracked);
  }

  function forget(sessionId: string): void {
    const tracked = sessions.get(sessionId);
    if (!tracked) return;
    stopWatching(tracked);
    sessions.delete(sessionId);
  }

  function dispose(): void {
    for (const tracked of sessions.values()) stopWatching(tracked);
    sessions.clear();
  }

  async function refresh(sessionId: string, tracked: TrackedSession): Promise<void> {
    const generation = ++tracked.generation;
    const cwd = tracked.cwd;
    const root = deps.resolveTheaterPath(tracked.theaterId);
    const [branch, headPath] = await Promise.all([readBranch(cwd), readGit(["rev-parse", "--git-path", "HEAD"], cwd)]);
    // 계산 중에 cwd가 바뀌었거나 세션이 사라졌으면 낡은 결과다.
    if (!enabled || tracked.generation !== generation || sessions.get(sessionId) !== tracked) return;
    deps.onChange(sessionId, projectWorkspace({ cwd, theaterRoot: root, branch }));
    if (headPath && tracked.unwatch === null) {
      const absoluteHead = path.isAbsolute(headPath) ? headPath : path.join(cwd, headPath);
      tracked.unwatch = watch(absoluteHead, () => {
        if (tracked.debounce) clearTimeout(tracked.debounce);
        tracked.debounce = setTimeout(() => {
          tracked.debounce = null;
          // 브랜치만 다시 읽는다 — 폴더는 cwd가 바뀔 때 observe가 다시 계산한다. 읽는 동안 cwd가
          // 바뀌면(observe가 세대를 올린다) 이 결과는 옛 디렉터리의 것이므로 버린다 — refresh와 같은 규칙이다.
          const readCwd = tracked.cwd;
          const readGeneration = tracked.generation;
          void readBranch(readCwd).then((next) => {
            if (!enabled || sessions.get(sessionId) !== tracked || tracked.generation !== readGeneration) return;
            deps.onChange(sessionId, projectWorkspace({ cwd: readCwd, theaterRoot: deps.resolveTheaterPath(tracked.theaterId), branch: next }));
          });
        }, HEAD_DEBOUNCE_MS);
      });
    }
  }

  async function readBranch(cwd: string): Promise<string | null> {
    const symbolic = await readGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (symbolic) return symbolic;
    // detached HEAD — 짧은 해시가 브랜치 자리를 대신한다. git이 아니면 둘 다 null이다.
    return readGit(["rev-parse", "--short", "HEAD"], cwd);
  }

  function stopWatching(tracked: TrackedSession): void {
    tracked.generation += 1;
    if (tracked.debounce) {
      clearTimeout(tracked.debounce);
      tracked.debounce = null;
    }
    tracked.unwatch?.();
    tracked.unwatch = null;
  }

  return { setEnabled, observe, forget, dispose };
}

/** 브라우저에 내보낼 수 있는 모양으로 접는다 — 절대 경로는 이 함수를 통과하지 못한다. */
export function projectWorkspace(input: { readonly cwd: string; readonly theaterRoot: string | null; readonly branch: string | null }): AgentSessionWorkspace {
  const branch = input.branch && input.branch.length > 0 ? input.branch : null;
  const cwd = path.resolve(input.cwd);
  if (input.theaterRoot) {
    const root = path.resolve(input.theaterRoot);
    const relative = path.relative(root, cwd);
    if (relative === "") return { folder: null, outside: false, branch };
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return { folder: relative.split(path.sep).join("/"), outside: false, branch };
    }
  }
  return { folder: path.basename(cwd) || null, outside: true, branch };
}

function defaultReadGit(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          finish(null);
          return;
        }
        const trimmed = String(stdout).trim();
        finish(trimmed.length > 0 ? trimmed : null);
      });
      child.on("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * HEAD 파일이 있는 디렉터리를 본다. 체크아웃은 HEAD를 rename으로 갈아 끼우므로 파일 자체를
 * 보면 첫 교체 뒤에 눈이 먼다 — 디렉터리를 보고 이름이 HEAD인 변화만 흘려보낸다.
 */
function defaultWatch(headPath: string, listener: () => void): (() => void) | null {
  const dir = path.dirname(headPath);
  const name = path.basename(headPath);
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === undefined || String(filename) === name) listener();
    });
    watcher.on("error", () => undefined);
    return () => watcher.close();
  } catch {
    return null;
  }
}
