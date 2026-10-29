import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnowledgeFolderAction, KnowledgeFolderResult } from "../shared/contracts/knowledge-folder.js";
import { CommodoreStoreError } from "./errors.js";

/** 퇴역한 지식의 위치만 연다. 생성·이주·본문 읽기 없이 사령관이 소유한 디렉터리만 다룬다. */
export function createKnowledgeFolderAction(deps: {
  readonly root: (commodoreId: string) => string | null;
  readonly openDirectory?: (directory: string) => Promise<void>;
}) {
  return async (commodoreId: string, action: KnowledgeFolderAction): Promise<KnowledgeFolderResult> => {
    const root = deps.root(commodoreId);
    if (!root) throw new CommodoreStoreError("unknown_commodore");
    let exists = false;
    try {
      const stat = fs.lstatSync(root);
      // 사용자 교체 링크로 다른 사령관·폴더를 열지 않는다. 상위 엔티티 경계는 root 해석이 검증한다.
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(root) !== root) return { status: "unavailable" };
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "unavailable" };
    }
    if (action === "display") {
      const relative = path.relative(os.homedir(), root);
      const inHome = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      return { status: "display", displayPath: inHome ? (relative ? `~${path.sep}${relative}` : "~") : root, exists };
    }
    if (!exists) return { status: "missing" };
    if (!deps.openDirectory) return { status: "unavailable" };
    try {
      await deps.openDirectory(root);
      return { status: "opened" };
    } catch { return { status: "unavailable" }; }
  };
}
