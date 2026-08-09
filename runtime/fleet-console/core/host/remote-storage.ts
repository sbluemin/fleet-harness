import fs from "node:fs";
import path from "node:path";

import { ensureSafeDirectory } from "@dotobokuri/core-infra";

/**
 * 원격 접속이 디스크에 남기는 것은 전부 이 디렉터리 하나에 모인다 — 이 콘솔의 신원,
 * 그 신원을 보고 붙은 기기들, 그리고 이 콘솔이 건너갈 다른 콘솔들.
 *
 * 한자리에 두는 이유는 이들의 수명이 하나로 묶여 있기 때문이다. 신원을 갈아 끼우면 그
 * 신원을 근거로 붙던 페어링이 함께 무효가 되고, 원격을 끄고 흔적을 지우는 일은 이
 * 디렉터리 하나를 지우는 일이다. 콘솔 데이터 루트에 흩어 두면 무엇을 함께 거둬야 하는지가
 * 코드를 따라 읽어야만 드러난다.
 *
 * 방향은 디렉터리가 아니라 이름이 가른다: `paired-devices`는 이리로 들어오는 기기,
 * `known-hosts`는 이 콘솔이 건너가는 상대다.
 */
const REMOTE_DIR = "remote";
const FILE_MODE = 0o600;

export type RemoteStorageFs = Pick<typeof fs, "renameSync" | "writeFileSync">;

export interface RemoteStorageDeps {
  readonly fileSystem?: RemoteStorageFs;
  /** 실제 디스크를 건드리지 않는 테스트가 갈아 끼우는 자리. */
  readonly ensureDirectory?: (directory: string) => void;
}

export interface RemoteStorage {
  path(file: string): string;
  write(file: string, content: string): void;
}

export function createRemoteStorage(consoleDir: string, deps: RemoteStorageDeps = {}): RemoteStorage {
  const fileSystem = deps.fileSystem ?? fs;
  /**
   * 매 쓰기마다 다시 확인한다. 만들 때 한 번만 0700을 주면 그 뒤에 느슨해진 권한을 되돌릴
   * 길이 없는데, 이 디렉터리에는 리스너의 개인키가 있다. 콘솔 데이터 루트가 durable state
   * 쓰기마다 같은 방식으로 굳는 것과 같은 계약이며, 심볼릭링크로 바꿔치기된 디렉터리는
   * 여기서 걸린다.
   */
  const ensureDirectory = deps.ensureDirectory ?? ensureSafeDirectory;
  const directory = path.join(consoleDir, REMOTE_DIR);

  return {
    path: (file) => path.join(directory, file),

    /**
     * temp+rename으로 갈아 끼운다. 쓰는 도중에 끊겨도 반쯤 쓰인 파일이 자리를 차지하지 않는다.
     * 파일은 만들어질 때부터 0600이어야 한다 — 나중에 고치면 그사이에 열린 파일이 있다.
     */
    write(file, content) {
      const target = path.join(directory, file);
      const temporary = `${target}.tmp`;
      ensureDirectory(directory);
      fileSystem.writeFileSync(temporary, content, { encoding: "utf8", mode: FILE_MODE });
      fileSystem.renameSync(temporary, target);
    },
  };
}
