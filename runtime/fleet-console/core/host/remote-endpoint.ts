import fs from "node:fs";

import { createRemoteStorage, type RemoteStorageDeps } from "./remote-storage.js";

/**
 * 이 콘솔이 손님에게 공표한 포트.
 *
 * 액세스 링크는 주소를 한 번 실어 보내고 그것으로 끝이다 — 상대는 그 주소를 저장해 두고
 * 이후로는 링크 없이 그리로 돌아온다. 그러니 그 주소는 콘솔이 다시 떠도 같은 곳을 가리켜야
 * 한다. 루프백 포트는 그런 약속을 하지 않는다(dynamic이면 OS가 매번 새로 고른다), 그래서
 * 원격 리스너는 처음 열릴 때의 포트를 여기에 적어 두고 그 뒤로는 그 포트만 연다.
 *
 * 신원·페어링과 한 디렉터리에 있는 이유도 같다. 셋은 "손님이 믿고 돌아오는 것"이라는 하나의
 * 수명을 공유한다 — 주소가 바뀌면 지문이 맞아도 닿지 못하고, 지문이 바뀌면 주소가 맞아도
 * 거절당한다.
 */
export interface RemoteEndpointStore {
  /** 공표해 둔 포트. 아직 원격을 연 적이 없으면 null이다. */
  read(): number | null;
  /** 실제 바인드에 성공한 뒤에만 부른다 — 열지 못한 포트를 공표된 것으로 남기지 않는다. */
  remember(port: number): void;
  /** 다음 기동이 포트를 다시 고르게 한다. 신원 갱신처럼 손님을 전부 내보내는 자리에서만 부른다. */
  forget(): void;
}

export type RemoteEndpointStoreDeps = RemoteStorageDeps & {
  readonly readFile?: (file: string) => string;
};

const ENDPOINT_FILE = "listener.json";
const STORE_VERSION = 1;

interface StoredFile {
  readonly version: number;
  readonly port: number | null;
}

export function createRemoteEndpointStore(consoleDir: string, deps: RemoteEndpointStoreDeps = {}): RemoteEndpointStore {
  const storage = createRemoteStorage(consoleDir, deps);
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  let port: number | null = read();

  function read(): number | null {
    try {
      const parsed = JSON.parse(readFile(storage.path(ENDPOINT_FILE))) as StoredFile;
      if (parsed?.version !== STORE_VERSION) return null;
      return isBindablePort(parsed.port) ? parsed.port : null;
    } catch {
      return null;
    }
  }

  function write(next: number | null): void {
    // 같은 값을 다시 쓰지 않는다 — 기동마다 파일을 갈아 끼울 이유가 없다.
    if (next === port) return;
    const body: StoredFile = { version: STORE_VERSION, port: next };
    storage.write(ENDPOINT_FILE, `${JSON.stringify(body, null, 2)}\n`);
    port = next;
  }

  return {
    read: () => port,
    remember: (next) => { if (isBindablePort(next)) write(next); },
    forget: () => write(null),
  };
}

/** 0은 "아무 포트나"라는 뜻이라 공표할 수 없다 — 기억해 두어도 다음 기동에 다른 곳이 열린다. */
function isBindablePort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}
