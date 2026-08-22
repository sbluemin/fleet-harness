import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { isProcessAlive } from "@dotobokuri/core-infra";

import { cleanupPrivateRoot, ensurePrivateDir, removePrivatePath, writePrivateFile, writePrivateJson } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";

/**
 * 스냅숏 저장소는 `marketplace/`의 형제 디렉터리다. `marketplace/plugins/` 아래에 두면
 * 안 된다 — 패치할 수 없는 구버전 CLI가 지금도 그 트리를 통째로 재렌더하고, 자기가 모르는
 * 형제 디렉터리를 전부 지우기 때문이다. 이 이름은 구버전이 절대 건드리지 않는 새 네임스페이스다.
 */
export const PLUGIN_SNAPSHOTS_DIR_NAME = "plugin-snapshots";

const SNAPSHOT_MANIFEST_NAME = ".fleet-snapshot.json";
const LEASES_DIR_NAME = "leases";
const STAGING_PREFIX = ".fleet-stage-";
const SNAPSHOT_HASH_PREFIX_LENGTH = 16;
// 리스가 전부 죽은 pid여도 이 유예 안에서는 지우지 않는다 — 데몬이 재시작하면 리스 pid는
// 죽어 보이지만 그 데몬이 띄운 Claude 자식은 살아 있을 수 있다. 유예는 그 창을 흡수한다.
const GC_GRACE_MS = 24 * 60 * 60 * 1000;
const GC_MAX_UNPINNED_SNAPSHOTS = 8;
const GC_STAGING_GRACE_MS = 60 * 60 * 1000;

export interface PluginSnapshotLease {
  readonly contentHash: string;
  readonly snapshotRoot: string;
  readonly release: () => void;
}

export interface PluginSnapshotGcDeps {
  readonly now?: () => number;
  readonly isPidAlive?: (pid: number) => boolean;
}

/**
 * 파일 집합의 내용 해시. 스냅숏 디렉터리 이름과 재사용 판정이 전부 이 값에서 나온다.
 * 매니페스트 자신은 해시 입력에 들어가지 않는다 — 넣으면 순환이다.
 */
export function hashPluginFiles(files: readonly AssetPluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function pluginSnapshotDirName(stem: string, contentHash: string): string {
  return `${stem}-${contentHash.slice(0, SNAPSHOT_HASH_PREFIX_LENGTH)}`;
}

/**
 * 내용 해시로 스냅숏을 확보한다. 호출자는 저장소 락을 이미 쥐고 있어야 한다.
 *
 * 발행된 스냅숏은 불변이다: 같은 해시는 검증 후 재사용하고, 검증에 실패한 디렉터리는
 * 살아 있는 리스가 하나라도 있으면 손대지 않고 런치를 실패시킨다 — 훅은 `${CLAUDE_PLUGIN_ROOT}`를
 * 이벤트 시점마다 다시 해석하므로, 실행 중 세션이 쥔 트리를 고쳐 쓰는 것은 조용한 정책 교체다.
 */
export function acquirePluginSnapshot(
  snapshotsRoot: string,
  stem: string,
  files: readonly AssetPluginFile[],
): PluginSnapshotLease {
  ensurePrivateDir(snapshotsRoot, snapshotsRoot);
  const contentHash = hashPluginFiles(files);
  const dirName = pluginSnapshotDirName(stem, contentHash);
  const snapshotRoot = path.join(snapshotsRoot, dirName);
  if (existsSync(snapshotRoot)) {
    if (!verifyPluginSnapshot(snapshotRoot, contentHash, files)) {
      if (hasLiveLease(snapshotsRoot, dirName)) {
        throw new Error(
          `Fleet plugin snapshot is corrupt while sessions still lease it: ${snapshotRoot}`,
        );
      }
      removePrivatePath(snapshotRoot, snapshotsRoot);
      publishPluginSnapshot(snapshotsRoot, dirName, contentHash, files);
    }
  } else {
    publishPluginSnapshot(snapshotsRoot, dirName, contentHash, files);
  }
  const release = writeSnapshotLease(snapshotsRoot, dirName);
  gcPluginSnapshots(snapshotsRoot, stem, dirName);
  return { contentHash, snapshotRoot, release };
}

function publishPluginSnapshot(
  snapshotsRoot: string,
  dirName: string,
  contentHash: string,
  files: readonly AssetPluginFile[],
): void {
  const stageParent = path.join(snapshotsRoot, `${STAGING_PREFIX}${process.pid}-${randomUUID()}`);
  const stagedRoot = path.join(stageParent, dirName);
  try {
    ensurePrivateDir(stagedRoot, stageParent);
    // 빈 로스터에서도 agents/는 존재해야 한다 — 소비자는 디렉터리 부재와 정체성 0개를 구분하지 않는다.
    ensurePrivateDir(path.join(stagedRoot, "agents"), stageParent);
    for (const file of files) {
      writePrivateFile(path.join(stagedRoot, ...file.relativePath.split("/")), file.content, stageParent);
    }
    writePrivateJson(path.join(stagedRoot, SNAPSHOT_MANIFEST_NAME), {
      version: 1,
      contentHash,
      renderedAt: Date.now(),
    }, stageParent);
    const snapshotRoot = path.join(snapshotsRoot, dirName);
    try {
      renameSync(stagedRoot, snapshotRoot);
    } catch (error) {
      // 락 아래라 정상 경합은 없다. 그래도 남아 있던 잔해와 부딪히면: 그 잔해가 온전한 같은
      // 내용이면 그대로 쓰고, 아니면 조용히 덮지 않고 런치를 실패시킨다.
      if (!verifyPluginSnapshot(snapshotRoot, contentHash, files)) throw error;
    }
  } finally {
    cleanupPrivateRoot(stageParent, snapshotsRoot);
  }
}

/**
 * 기대 파일 전량을 바이트 비교로 검증한다. 여분 파일은 실패 사유가 아니다 — 실패는
 * 매니페스트 해시 불일치이거나 기대 파일의 부재·변조다.
 */
function verifyPluginSnapshot(
  snapshotRoot: string,
  contentHash: string,
  files: readonly AssetPluginFile[],
): boolean {
  try {
    const manifestRaw = readFileSync(path.join(snapshotRoot, SNAPSHOT_MANIFEST_NAME), "utf8");
    const manifest = JSON.parse(manifestRaw) as { readonly contentHash?: unknown };
    if (manifest.contentHash !== contentHash) return false;
    for (const file of files) {
      const onDisk = readFileSync(path.join(snapshotRoot, ...file.relativePath.split("/")), "utf8");
      if (onDisk !== file.content) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function leasesRootFor(snapshotsRoot: string, dirName: string): string {
  return path.join(snapshotsRoot, LEASES_DIR_NAME, dirName);
}

function writeSnapshotLease(snapshotsRoot: string, dirName: string): () => void {
  const leaseDir = leasesRootFor(snapshotsRoot, dirName);
  // Console 데몬은 여러 세션이 한 pid를 공유하므로 리스 정체성은 pid가 아니라 pid+nonce다.
  const leasePath = path.join(leaseDir, `${process.pid}-${randomUUID()}.json`);
  writePrivateJson(leasePath, { pid: process.pid, startedAt: Date.now() }, snapshotsRoot);
  return () => {
    try {
      removePrivatePath(leasePath, snapshotsRoot);
    } catch {
      // 리스 해제 실패는 세션 종료를 막지 않는다. 남은 리스는 pid 사망 후 GC가 회수한다.
    }
  };
}

function hasLiveLease(
  snapshotsRoot: string,
  dirName: string,
  isPidAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  const leaseDir = leasesRootFor(snapshotsRoot, dirName);
  if (!existsSync(leaseDir)) return false;
  for (const entry of readdirSync(leaseDir)) {
    try {
      const lease = JSON.parse(readFileSync(path.join(leaseDir, entry), "utf8")) as { readonly pid?: unknown };
      if (typeof lease.pid !== "number") return true;
      if (isPidAlive(lease.pid)) return true;
    } catch {
      // 읽을 수 없는 리스는 살아 있는 것으로 취급한다 — 불확실을 삭제로 해소하지 않는다.
      return true;
    }
  }
  return false;
}

/**
 * best-effort 회수. 현재 스냅숏과 살아 있는 리스가 있는 스냅숏은 절대 지우지 않고,
 * 나머지는 유예를 넘겼거나 상한을 초과한 오래된 것부터 지운다. 어떤 실패도 런치를 막지 않는다.
 *
 * 리스 흔적이 남은(파일은 있는데 pid가 전부 죽은) 스냅숏은 유예 안에서는 상한으로도 지우지
 * 않는다 — 데몬이 재시작하면 리스 pid는 죽어 보여도 그 데몬이 띄운 Claude 자식이 아직 그
 * 트리의 훅을 읽고 있을 수 있다. 상한은 정상 반납되어 리스 흔적이 전혀 없는, 고아가 있을 수
 * 없는 스냅숏에만 적용한다.
 */
export function gcPluginSnapshots(
  snapshotsRoot: string,
  stem: string,
  keepDirName: string,
  deps: PluginSnapshotGcDeps = {},
): void {
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? isProcessAlive;
  try {
    const snapshotPattern = new RegExp(`^${escapeRegExp(stem)}-[0-9a-f]{${SNAPSHOT_HASH_PREFIX_LENGTH}}$`);
    const unpinned: Array<{ readonly dirName: string; readonly hasLeaseTrace: boolean; readonly lastUsedAt: number }> = [];
    for (const entry of readdirSync(snapshotsRoot)) {
      try {
        if (entry.startsWith(STAGING_PREFIX)) {
          if (now() - entryMtimeMs(snapshotsRoot, entry) > GC_STAGING_GRACE_MS) {
            removePrivatePath(path.join(snapshotsRoot, entry), snapshotsRoot);
          }
          continue;
        }
        if (!snapshotPattern.test(entry) || entry === keepDirName) continue;
        if (hasLiveLease(snapshotsRoot, entry, isPidAlive)) continue;
        unpinned.push({
          dirName: entry,
          hasLeaseTrace: hasAnyLeaseTrace(snapshotsRoot, entry),
          lastUsedAt: snapshotLastUsedAt(snapshotsRoot, entry),
        });
      } catch {
        continue;
      }
    }
    unpinned.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const [index, snapshot] of unpinned.entries()) {
      const beyondCap = unpinned.length - index > GC_MAX_UNPINNED_SNAPSHOTS;
      const beyondGrace = now() - snapshot.lastUsedAt > GC_GRACE_MS;
      const capCollectable = beyondCap && !snapshot.hasLeaseTrace;
      if (!capCollectable && !beyondGrace) continue;
      try {
        removePrivatePath(path.join(snapshotsRoot, snapshot.dirName), snapshotsRoot);
        removePrivatePath(leasesRootFor(snapshotsRoot, snapshot.dirName), snapshotsRoot);
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

/** 리스 파일이 하나라도 남아 있는가 — pid 생사와 무관한 흔적 판정. 정상 반납된 세션은 파일을 지우고 간다. */
function hasAnyLeaseTrace(snapshotsRoot: string, dirName: string): boolean {
  const leaseDir = leasesRootFor(snapshotsRoot, dirName);
  if (!existsSync(leaseDir)) return false;
  return readdirSync(leaseDir).length > 0;
}

function snapshotLastUsedAt(snapshotsRoot: string, dirName: string): number {
  let lastUsedAt = 0;
  try {
    const manifestRaw = readFileSync(path.join(snapshotsRoot, dirName, SNAPSHOT_MANIFEST_NAME), "utf8");
    const manifest = JSON.parse(manifestRaw) as { readonly renderedAt?: unknown };
    if (typeof manifest.renderedAt === "number") lastUsedAt = manifest.renderedAt;
  } catch {
    lastUsedAt = entryMtimeMs(snapshotsRoot, dirName);
  }
  const leaseDir = leasesRootFor(snapshotsRoot, dirName);
  if (existsSync(leaseDir)) {
    for (const entry of readdirSync(leaseDir)) {
      try {
        lastUsedAt = Math.max(lastUsedAt, statSync(path.join(leaseDir, entry)).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return lastUsedAt;
}

function entryMtimeMs(parent: string, entry: string): number {
  try {
    return statSync(path.join(parent, entry)).mtimeMs;
  } catch {
    return 0;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
