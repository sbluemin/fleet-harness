import * as fs from "node:fs";

import { NOFOLLOW_FLAG } from "../fs-store/secure-fs.js";
import type { AuthStorageData } from "./types.js";

/**
 * fd 기반 안전 읽기: O_RDONLY|O_NOFOLLOW + fstatSync isFile 검증.
 * 심볼릭링크(ELOOP)·권한(EACCES)·파싱 오류는 모두 삼키고 빈 store({})를 반환한다.
 * auth-storage(서비스 읽기 경로)가 공유하는 symlink 방어 읽기의 단일 구현이다.
 */
export function readAuthStoreFile(filePath: string): AuthStorageData {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    if (!fs.fstatSync(fd).isFile()) {
      return {};
    }
    return JSON.parse(fs.readFileSync(fd, "utf-8")) as AuthStorageData;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
